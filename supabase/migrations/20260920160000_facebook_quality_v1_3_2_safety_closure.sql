begin;

-- Canonical membership/lifecycle reconciliation. The deterministic decision is
-- computed by the application; this function makes its persisted projection
-- atomic with the membership upsert and serializes the target listing.
create or replace function public.reconcile_canonical_listing_decision(
  p_listing_id uuid,
  p_filter_id uuid,
  p_bucket text,
  p_reasons jsonb,
  p_missing_fields jsonb,
  p_lifecycle_status text,
  p_match_origin text default 'scan',
  p_source_scan_id uuid default null,
  p_matched_at timestamptz default now()
)
returns table (
  listing_id uuid,
  search_filter_id uuid,
  bucket text,
  lifecycle_status text,
  is_current_match boolean,
  match_reasons jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.listings%rowtype;
  normalized_reasons jsonb;
  normalized_missing jsonb;
  current_match boolean;
  next_lifecycle text;
begin
  if p_bucket not in ('MATCHED', 'REVIEW', 'REJECTED') then
    raise exception 'CANONICAL_BUCKET_INVALID';
  end if;
  if p_match_origin not in ('scan', 'filter_recalculation', 'collector_import') then
    raise exception 'CANONICAL_MATCH_ORIGIN_INVALID';
  end if;
  if jsonb_typeof(coalesce(p_reasons, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_missing_fields, '[]'::jsonb)) <> 'array' then
    raise exception 'CANONICAL_REASONS_INVALID';
  end if;

  select * into target
    from public.listings
   where id = p_listing_id
   for update;
  if target.id is null then
    raise exception 'CANONICAL_LISTING_NOT_FOUND';
  end if;
  if not exists (select 1 from public.search_filters where id = p_filter_id) then
    raise exception 'CANONICAL_FILTER_NOT_FOUND';
  end if;

  normalized_reasons := coalesce(p_reasons, '[]'::jsonb);
  normalized_missing := coalesce(p_missing_fields, '[]'::jsonb);
  current_match := p_bucket = 'MATCHED';
  next_lifecycle := case when p_bucket = 'MATCHED' then 'ACTIVE' else p_lifecycle_status end;
  if next_lifecycle not in ('ACTIVE', 'REVIEW', 'REJECTED', 'STALE', 'ARCHIVED') then
    raise exception 'CANONICAL_LIFECYCLE_INVALID';
  end if;

  if p_bucket = 'REVIEW' and not (normalized_reasons ? 'review') then
    normalized_reasons := jsonb_build_array('review') || normalized_reasons;
  end if;
  if p_bucket = 'REVIEW' then
    normalized_reasons := normalized_reasons || coalesce(
      (select jsonb_agg('unknown_' || value)
         from jsonb_array_elements_text(normalized_missing) as fields(value)
        where not (normalized_reasons ? ('unknown_' || value))),
      '[]'::jsonb
    );
  end if;

  update public.listings
     set lifecycle_status = next_lifecycle,
         archived_at = case when p_bucket in ('MATCHED', 'REVIEW') then null else archived_at end,
         review_reason = case when p_bucket = 'REVIEW' then array_to_string(array(select jsonb_array_elements_text(normalized_reasons)), ', ') else null end,
         missing_fields = case when p_bucket = 'REVIEW' then normalized_missing else '[]'::jsonb end,
         status = 'active'
   where id = p_listing_id;

  insert into public.listing_filter_matches (
    listing_id, search_filter_id, last_matched_at, is_current_match,
    match_reasons, match_origin, source_scan_id
  ) values (
    p_listing_id, p_filter_id, coalesce(p_matched_at, now()), current_match,
    normalized_reasons, p_match_origin, p_source_scan_id
  )
  on conflict (listing_id, search_filter_id) do update set
    last_matched_at = excluded.last_matched_at,
    is_current_match = excluded.is_current_match,
    match_reasons = excluded.match_reasons,
    match_origin = excluded.match_origin,
    source_scan_id = excluded.source_scan_id;

  return query select p_listing_id, p_filter_id, p_bucket, next_lifecycle, current_match, normalized_reasons;
end;
$$;

revoke all on function public.reconcile_canonical_listing_decision(uuid, uuid, text, jsonb, jsonb, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_canonical_listing_decision(uuid, uuid, text, jsonb, jsonb, text, text, uuid, timestamptz) to service_role;

-- Atomically prove one exact Facebook post, reset only gallery state, and enqueue
-- one hydration job. The listing row lock serializes concurrent repair clicks;
-- the existing partial unique index remains a second duplicate-job guard.
create or replace function public.repair_facebook_gallery_job(p_listing_id uuid)
returns table (
  listing_id uuid,
  gallery_job_id uuid,
  expected_post_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.listings%rowtype;
  metadata_row public.listing_source_metadata%rowtype;
  metadata_count integer;
  listing_post_id text;
  listing_group text;
  metadata_group text;
  filter_id uuid;
  active_job uuid;
  new_job public.facebook_scan_jobs%rowtype;
  next_metadata jsonb;
begin
  select * into target from public.listings where id = p_listing_id for update;
  if target.id is null or target.source <> 'facebook' then raise exception 'FACEBOOK_GALLERY_LISTING_NOT_FOUND'; end if;
  if target.lifecycle_status in ('REJECTED', 'ARCHIVED', 'STALE') or target.manual_decision = 'REJECTED' then raise exception 'FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE'; end if;

  listing_post_id := substring(target.external_listing_id from '^([0-9]{5,30})$');
  listing_group := substring(target.original_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/[0-9]{5,30}(?:/|$)');
  if listing_post_id is null or listing_group is null then raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED'; end if;

  select count(*) into metadata_count
    from public.listing_source_metadata m
   where m.listing_id = p_listing_id
     and m.source = 'facebook'
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') is not null
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/[^/]+/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') = listing_post_id;
  if metadata_count <> 1 then raise exception 'FACEBOOK_GALLERY_METADATA_IDENTITY_AMBIGUOUS'; end if;

  select * into metadata_row
    from public.listing_source_metadata m
   where m.listing_id = p_listing_id
     and m.source = 'facebook'
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/[^/]+/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') = listing_post_id
   order by m.collected_at desc
   limit 1
   for update;
  metadata_group := substring(metadata_row.source_post_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/[0-9]{5,30}(?:/|$)');
  if metadata_group is null or metadata_group <> listing_group then raise exception 'FACEBOOK_GALLERY_METADATA_GROUP_MISMATCH'; end if;

  select m.search_filter_id into filter_id
    from public.listing_filter_matches m
   where m.listing_id = p_listing_id
     and (m.is_current_match = true or m.match_reasons ? 'review' or exists (
       select 1 from jsonb_array_elements_text(coalesce(m.match_reasons, '[]'::jsonb)) reasons(value) where reasons.value like 'unknown_%'
     ))
   order by m.last_matched_at desc
   limit 1;
  if filter_id is null then raise exception 'FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING'; end if;

  select jobs.id into active_job
    from public.facebook_scan_jobs jobs
   where jobs.job_type = 'GALLERY_HYDRATION'
     and jobs.gallery_listing_id = p_listing_id
     and jobs.status in ('queued', 'claimed', 'running')
   order by jobs.created_at desc
   limit 1
   for update;
  if active_job is not null then raise exception 'FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING'; end if;

  next_metadata := coalesce(metadata_row.metadata, '{}'::jsonb) - 'galleryMediaIds' - 'galleryStatus' - 'galleryUpdatedAt' - 'galleryError';
  update public.listings
     set images = '[]'::jsonb, gallery_status = 'NOT_REQUESTED', gallery_job_id = null,
         gallery_requested_at = null, gallery_completed_at = null, gallery_error = null,
         gallery_total = 0, gallery_persisted_count = 0
   where id = p_listing_id;
  update public.listing_source_metadata set metadata = next_metadata where id = metadata_row.id;

  insert into public.facebook_scan_jobs (
    scan_run_id, source_scan_id, search_filter_id, status, group_snapshot,
    idempotency_key, consumer_type, job_type, priority, gallery_listing_id,
    gallery_post_id, gallery_source_url, available_at
  ) values (
    gen_random_uuid(), null, filter_id, 'queued', '[]'::jsonb,
    'gallery:' || p_listing_id::text || ':' || gen_random_uuid()::text,
    'BROWSER_EXTENSION', 'GALLERY_HYDRATION', 100, p_listing_id,
    listing_post_id, metadata_row.source_post_url, now()
  ) returning * into new_job;

  update public.listings set gallery_status = 'PENDING', gallery_job_id = new_job.id, gallery_requested_at = now(), gallery_error = null where id = p_listing_id;
  return query select p_listing_id, new_job.id, listing_post_id;
end;
$$;

revoke all on function public.repair_facebook_gallery_job(uuid) from public, anon, authenticated;
grant execute on function public.repair_facebook_gallery_job(uuid) to service_role;

-- History clear takes short table locks so every current Facebook enqueue/claim
-- path is excluded for the whole destructive transaction. This is deliberately
-- stronger than an advisory lock: no competing path needs to remember to opt in.
create or replace function public.clear_facebook_watcher_history_atomic()
returns table (
  pure_facebook_listing_ids uuid[],
  preserved_listing_ids uuid[],
  removed_association_listing_ids uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  pure_ids uuid[];
  preserved_ids uuid[];
begin
  lock table public.source_scans, public.facebook_scan_jobs, public.listings,
    public.listing_source_metadata, public.properties, public.deals
    in share row exclusive mode;

  if exists (select 1 from public.source_scans where source = 'facebook' and status in ('pending', 'running'))
     or exists (select 1 from public.facebook_scan_jobs where job_type in ('SOURCE_SCAN', 'GALLERY_HYDRATION') and status in ('queued', 'claimed', 'running')) then
    raise exception 'ACTIVE_FACEBOOK_WORK';
  end if;

  with candidates as (
    select distinct m.listing_id,
      l.source as listing_source,
      (m.metadata @> '{"crossSourceMatch": true}'::jsonb) as cross_source,
      exists (select 1 from public.properties p where p.listing_id = m.listing_id) as linked_property,
      exists (select 1 from public.deals d where d.listing_id = m.listing_id) as linked_deal
    from public.listing_source_metadata m
    join public.listings l on l.id = m.listing_id
    where m.source = 'facebook'
  ), classified as (
    select listing_id,
      (listing_source <> 'facebook' or cross_source or linked_property or linked_deal) as preserved
    from candidates
  )
  select coalesce(array_agg(listing_id) filter (where not preserved), '{}'), coalesce(array_agg(listing_id) filter (where preserved), '{}')
    into pure_ids, preserved_ids
    from classified;

  if coalesce(array_length(pure_ids, 1), 0) > 0 then
    delete from public.listings where source = 'facebook' and id = any(pure_ids);
  end if;
  if coalesce(array_length(preserved_ids, 1), 0) > 0 then
    delete from public.listing_source_metadata where source = 'facebook' and listing_id = any(preserved_ids);
  end if;

  return query select coalesce(pure_ids, '{}'), coalesce(preserved_ids, '{}'), coalesce(preserved_ids, '{}');
end;
$$;

revoke all on function public.clear_facebook_watcher_history_atomic() from public, anon, authenticated;
grant execute on function public.clear_facebook_watcher_history_atomic() to service_role;

commit;
