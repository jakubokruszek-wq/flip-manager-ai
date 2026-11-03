begin;

-- Only identity tombstones are retained. No source text, photos or credentials.
create table public.facebook_watcher_removed_posts (
  post_id text primary key check (post_id ~ '^[0-9]{5,30}$'),
  removed_at timestamptz not null default now()
);
alter table public.facebook_watcher_removed_posts enable row level security;
revoke all on public.facebook_watcher_removed_posts from public, anon, authenticated;
grant select, insert on public.facebook_watcher_removed_posts to service_role;

-- The DB fence also covers imports already in flight when cleanup commits.
create function public.guard_removed_facebook_post() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare v_post_id text;
begin
  if new.source = 'facebook' then
    v_post_id := substring(new.external_listing_id from '^(?:facebook:post:)?([0-9]{5,30})$');
    if v_post_id is not null and exists (select 1 from public.facebook_watcher_removed_posts t where t.post_id = v_post_id) then
      raise exception 'FACEBOOK_POST_REMOVED';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_removed_facebook_post() from public, anon, authenticated;
create trigger guard_removed_facebook_post before insert or update on public.listings
for each row execute function public.guard_removed_facebook_post();

-- This service-only boundary needs definer access to protected CRM/deal links,
-- like the existing all-history cleanup. Browser roles cannot execute it.
create function public.facebook_watcher_cleanup_saved_before(p_before timestamptz, p_apply boolean default false, p_expected text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare pure_ids uuid[]; protected_ids uuid[]; signature text;
begin
  if p_before is null or p_before <= '1970-01-01'::timestamptz or p_before > now() then raise exception 'INVALID_SAVED_CUTOFF'; end if;
  if p_apply then
    lock table public.source_scans, public.facebook_scan_jobs, public.listings,
      public.listing_source_metadata, public.properties, public.deals, public.collector_imports in share row exclusive mode;
  end if;
  if exists (select 1 from public.source_scans where source='facebook' and status in ('pending','running'))
    or exists (select 1 from public.facebook_scan_jobs where job_type in ('SOURCE_SCAN','GALLERY_HYDRATION') and status in ('queued','claimed','running')) then
    raise exception 'ACTIVE_FACEBOOK_WORK';
  end if;
  with candidates as (
    select l.id, bool_or(l.source <> 'facebook' or coalesce(m.metadata @> '{"crossSourceMatch":true}'::jsonb,false)
      or exists(select 1 from public.properties p where p.listing_id=l.id)
      or exists(select 1 from public.deals d where d.listing_id=l.id)) as protected
    from public.listings l join public.listing_source_metadata m on m.listing_id=l.id and m.source='facebook'
    where l.created_at < p_before
    group by l.id
  ) select coalesce(array_agg(id order by id) filter(where not protected),'{}'),
           coalesce(array_agg(id order by id) filter(where protected),'{}')
    into pure_ids, protected_ids from candidates;
  signature := md5(p_before::text || ':' || array_to_string(pure_ids,',') || ':' || array_to_string(protected_ids,','));
  if p_apply then
    if p_expected is distinct from signature then raise exception 'CLEANUP_PREVIEW_CHANGED'; end if;
    insert into public.facebook_watcher_removed_posts(post_id)
      select distinct coalesce(case when m.metadata->>'postId' ~ '^[0-9]{5,30}$' then m.metadata->>'postId' end,
        substring(m.source_post_url from '/(?:posts|permalink)/([0-9]{5,30})(?:/|$)'),
        substring(l.external_listing_id from '^(?:facebook:post:)?([0-9]{5,30})$'))
      from public.listing_source_metadata m join public.listings l on l.id=m.listing_id
      where l.id=any(pure_ids) and m.source='facebook'
        and coalesce(case when m.metadata->>'postId' ~ '^[0-9]{5,30}$' then m.metadata->>'postId' end,
          substring(m.source_post_url from '/(?:posts|permalink)/([0-9]{5,30})(?:/|$)'),
          substring(l.external_listing_id from '^(?:facebook:post:)?([0-9]{5,30})$')) is not null
      on conflict do nothing;
    -- Retain receipt/replay identity but erase the old business snapshot.
    update public.collector_imports set payload='{}'::jsonb, result='{"removed":true}'::jsonb, error_message=null where listing_id=any(pure_ids);
    delete from public.listings where id=any(pure_ids) and source='facebook';
  end if;
  return jsonb_build_object('before',p_before,'token',signature,'listingIds',to_jsonb(pure_ids),
    'total',cardinality(pure_ids),'protectedCount',cardinality(protected_ids),'applied',p_apply);
end;
$$;
revoke all on function public.facebook_watcher_cleanup_saved_before(timestamptz,boolean,text) from public, anon, authenticated;
grant execute on function public.facebook_watcher_cleanup_saved_before(timestamptz,boolean,text) to service_role;
commit;
