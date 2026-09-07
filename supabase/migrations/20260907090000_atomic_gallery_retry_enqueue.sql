begin;

-- Atomically serialize gallery requests for one listing. The listing row lock,
-- active-job partial unique index and transaction-scoped insert/update prevent
-- duplicate active jobs and silent orphan jobs under concurrent retries.
create or replace function public.enqueue_facebook_gallery_job(
  p_listing_id uuid,
  p_search_filter_id uuid,
  p_post_id text,
  p_source_url text
)
returns table (
  job_id uuid,
  gallery_status text,
  job_created boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.listings%rowtype;
  active_job public.facebook_scan_jobs%rowtype;
  new_job public.facebook_scan_jobs%rowtype;
begin
  select * into target
    from public.listings
   where id = p_listing_id
   for update;

  if target.id is null or target.source <> 'facebook' then
    raise exception 'FACEBOOK_GALLERY_LISTING_NOT_FOUND';
  end if;
  if target.lifecycle_status in ('REJECTED', 'ARCHIVED', 'STALE') or target.manual_decision = 'REJECTED' then
    raise exception 'FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE';
  end if;
  if p_post_id is null or p_post_id !~ '^[0-9]{5,30}$' or target.external_listing_id <> p_post_id then
    raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED';
  end if;
  if p_source_url is null or p_source_url !~ ('^https://(www[.])?facebook[.]com/groups/[^/]+/(posts|permalink)/' || p_post_id || '(/|$)') then
    raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED';
  end if;
  if not exists (
    select 1 from public.listing_filter_matches
     where listing_id = p_listing_id and search_filter_id = p_search_filter_id
  ) then
    raise exception 'FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING';
  end if;

  if target.gallery_status = 'COMPLETE' then
    return query select target.gallery_job_id, 'COMPLETE'::text, false;
    return;
  end if;

  select * into active_job
    from public.facebook_scan_jobs jobs
   where jobs.job_type = 'GALLERY_HYDRATION'
     and jobs.gallery_listing_id = p_listing_id
     and jobs.status in ('queued', 'running')
   order by jobs.created_at desc
   limit 1;

  if active_job.id is not null then
    update public.listings
       set gallery_status = case when active_job.status = 'running' then 'RUNNING' else 'PENDING' end,
           gallery_job_id = active_job.id,
           gallery_requested_at = coalesce(gallery_requested_at, now()),
           gallery_completed_at = null,
           gallery_error = null
     where id = p_listing_id;
    return query select active_job.id,
      case when active_job.status = 'running' then 'RUNNING'::text else 'PENDING'::text end,
      false;
    return;
  end if;

  insert into public.facebook_scan_jobs (
    scan_run_id,
    source_scan_id,
    search_filter_id,
    status,
    group_snapshot,
    idempotency_key,
    consumer_type,
    job_type,
    priority,
    gallery_listing_id,
    gallery_post_id,
    gallery_source_url,
    available_at
  ) values (
    gen_random_uuid(),
    null,
    p_search_filter_id,
    'queued',
    '[]'::jsonb,
    'gallery:' || p_listing_id::text || ':' || gen_random_uuid()::text,
    'BROWSER_EXTENSION',
    'GALLERY_HYDRATION',
    100,
    p_listing_id,
    p_post_id,
    p_source_url,
    now()
  ) returning * into new_job;

  update public.listings
     set gallery_status = 'PENDING',
         gallery_job_id = new_job.id,
         gallery_requested_at = now(),
         gallery_completed_at = null,
         gallery_error = null
   where id = p_listing_id;

  return query select new_job.id, 'PENDING'::text, true;
end;
$$;

revoke all on function public.enqueue_facebook_gallery_job(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_facebook_gallery_job(uuid, uuid, text, text) to service_role;

commit;
