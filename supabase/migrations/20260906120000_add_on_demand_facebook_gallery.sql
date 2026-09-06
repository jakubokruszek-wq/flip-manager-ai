begin;

-- A gallery request is a first-class operation on the existing Facebook queue.
-- It never changes listing lifecycle/decision state and is claimed by the same
-- signed browser-extension consumer as a source scan.
alter table public.facebook_scan_jobs
  add column if not exists job_type text not null default 'SOURCE_SCAN',
  add column if not exists priority integer not null default 0,
  add column if not exists gallery_listing_id uuid references public.listings(id) on delete cascade,
  add column if not exists gallery_post_id text,
  add column if not exists gallery_source_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'facebook_scan_jobs_job_type_check'
       and conrelid = 'public.facebook_scan_jobs'::regclass
  ) then
    alter table public.facebook_scan_jobs
      add constraint facebook_scan_jobs_job_type_check
      check (job_type in ('SOURCE_SCAN', 'GALLERY_HYDRATION'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'facebook_scan_jobs_priority_nonnegative'
       and conrelid = 'public.facebook_scan_jobs'::regclass
  ) then
    alter table public.facebook_scan_jobs
      add constraint facebook_scan_jobs_priority_nonnegative check (priority >= 0);
  end if;
end;
$$;

-- Gallery jobs do not have a source_scan row. Source scans remain unique when
-- present, while a nullable column allows the same queue to carry hydration.
alter table public.facebook_scan_jobs
  alter column source_scan_id drop not null;

do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
    from pg_constraint con
   where con.conrelid = 'public.facebook_scan_jobs'::regclass
     and con.contype = 'u'
     and pg_get_constraintdef(con.oid) = 'UNIQUE (source_scan_id)';
  if constraint_name is not null then
    execute format('alter table public.facebook_scan_jobs drop constraint %I', constraint_name);
  end if;
end;
$$;

-- The legacy global idempotency key is retained for source scans but must not
-- prevent a safe retry after a partial gallery hydration. Scope uniqueness to
-- source-scan jobs; the active-gallery index below remains the gallery
-- singleton guard.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
    from pg_constraint con
   where con.conrelid = 'public.facebook_scan_jobs'::regclass
     and con.contype = 'u'
     and pg_get_constraintdef(con.oid) = 'UNIQUE (idempotency_key)';
  if constraint_name is not null then
    execute format('alter table public.facebook_scan_jobs drop constraint %I', constraint_name);
  end if;
end;
$$;

create unique index if not exists facebook_scan_jobs_source_idempotency_unique
  on public.facebook_scan_jobs (idempotency_key)
  where job_type = 'SOURCE_SCAN';

create unique index if not exists facebook_scan_jobs_source_scan_id_unique
  on public.facebook_scan_jobs (source_scan_id)
  where source_scan_id is not null;

create unique index if not exists facebook_scan_jobs_gallery_active_unique
  on public.facebook_scan_jobs (gallery_listing_id)
  where job_type = 'GALLERY_HYDRATION' and status in ('queued', 'running') and gallery_listing_id is not null;

create index if not exists facebook_scan_jobs_consumer_priority_claim_idx
  on public.facebook_scan_jobs (consumer_type, status, priority desc, available_at, created_at)
  where status = 'queued';

alter table public.listings
  add column if not exists gallery_status text not null default 'NOT_REQUESTED',
  add column if not exists gallery_job_id uuid,
  add column if not exists gallery_requested_at timestamptz,
  add column if not exists gallery_completed_at timestamptz,
  add column if not exists gallery_error text,
  add column if not exists gallery_total integer not null default 0,
  add column if not exists gallery_persisted_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'listings_gallery_status_check'
       and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings add constraint listings_gallery_status_check
      check (gallery_status in ('NOT_REQUESTED', 'PENDING', 'RUNNING', 'PARTIAL', 'COMPLETE', 'FAILED'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'listings_gallery_counts_nonnegative'
       and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings add constraint listings_gallery_counts_nonnegative
      check (gallery_total >= 0 and gallery_persisted_count >= 0);
  end if;
end;
$$;

create index if not exists listings_gallery_status_idx
  on public.listings (gallery_status, gallery_requested_at desc);

-- Keep claim atomic and consumer-scoped. Manual gallery jobs have priority 100;
-- normal source scans retain priority 0 and are never interrupted once running.
create or replace function public.claim_facebook_scan_job(
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_consumer_type text default 'LEGACY_WORKER'
)
returns setof public.facebook_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.facebook_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;
  if p_consumer_type not in ('BROWSER_EXTENSION', 'LEGACY_WORKER') then
    raise exception 'consumer_type is invalid';
  end if;

  with exhausted as (
    update public.facebook_scan_jobs as jobs
       set status = 'failed', finished_at = now(), leased_until = null,
           lease_token = null, error_code = 'LEASE_EXHAUSTED',
           error_message = 'Facebook worker lease expired after maximum attempts'
     where jobs.status = 'running' and jobs.leased_until < now() and jobs.attempts >= jobs.max_attempts
     returning jobs.source_scan_id
  )
  update public.source_scans scans
     set status = 'failed', finished_at = now(),
         error_message = 'Facebook worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted where source_scan_id is not null)
     and scans.status in ('pending', 'running');

  update public.facebook_scan_jobs as jobs
     set status = 'queued', available_at = now(), leased_until = null,
         lease_token = null, worker_id = null, error_code = 'LEASE_RECOVERED',
         error_message = 'Previous Facebook worker lease expired'
   where jobs.status = 'running' and jobs.leased_until < now() and jobs.attempts < jobs.max_attempts;

  select * into claimed
    from public.facebook_scan_jobs as jobs
   where jobs.status = 'queued'
     and jobs.consumer_type = p_consumer_type
     and jobs.available_at <= now()
     and jobs.attempts < jobs.max_attempts
   order by jobs.priority desc, jobs.created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.facebook_scan_jobs as jobs
     set status = 'running', attempts = jobs.attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), worker_id = p_worker_id,
         started_at = coalesce(jobs.started_at, now()), error_code = null,
         error_message = null
   where jobs.id = claimed.id
   returning * into claimed;

  if claimed.source_scan_id is not null then
    update public.source_scans
       set status = 'running', error_message = null
     where id = claimed.source_scan_id and status = 'pending';
  end if;

  if claimed.job_type = 'GALLERY_HYDRATION' and claimed.gallery_listing_id is not null then
    update public.listings
       set gallery_status = 'RUNNING', gallery_job_id = claimed.id
     where id = claimed.gallery_listing_id;
  end if;

  return next claimed;
end;
$$;

revoke all on function public.claim_facebook_scan_job(text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_facebook_scan_job(text, integer, text) to service_role;

commit;
