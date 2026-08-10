begin;

alter table public.source_scans
  drop constraint if exists source_scans_status_check;

alter table public.source_scans
  add constraint source_scans_status_check
  check (status in ('pending', 'running', 'completed', 'failed', 'partial'));

create table if not exists public.olx_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null,
  source_scan_id uuid not null unique references public.source_scans(id) on delete cascade,
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  request_url text not null,
  filter_snapshot jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  heartbeat_at timestamptz,
  worker_id text,
  result_summary jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint olx_scan_jobs_request_url_check check (
    request_url ~ '^https://(www\.)?olx\.pl/'
  ),
  constraint olx_scan_jobs_filter_snapshot_object check (
    jsonb_typeof(filter_snapshot) = 'object'
  ),
  constraint olx_scan_jobs_result_summary_object check (
    result_summary is null or jsonb_typeof(result_summary) = 'object'
  )
);

create index if not exists olx_scan_jobs_claim_idx
  on public.olx_scan_jobs (status, available_at, created_at)
  where status = 'queued';

create index if not exists olx_scan_jobs_lease_idx
  on public.olx_scan_jobs (leased_until)
  where status = 'running';

create index if not exists olx_scan_jobs_run_idx
  on public.olx_scan_jobs (scan_run_id, created_at desc);

create table if not exists public.olx_worker_nonces (
  nonce text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists olx_worker_nonces_expires_at_idx
  on public.olx_worker_nonces (expires_at);

create or replace function public.set_olx_scan_job_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists olx_scan_jobs_set_updated_at on public.olx_scan_jobs;
create trigger olx_scan_jobs_set_updated_at
before update on public.olx_scan_jobs
for each row execute function public.set_olx_scan_job_updated_at();

create or replace function public.claim_olx_scan_job(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns setof public.olx_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.olx_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  with exhausted as (
    update public.olx_scan_jobs
       set status = 'failed',
           finished_at = now(),
           leased_until = null,
           lease_token = null,
           error_code = 'LEASE_EXHAUSTED',
           error_message = 'Worker lease expired after maximum attempts'
     where status = 'running'
       and leased_until < now()
       and attempts >= max_attempts
     returning source_scan_id
  )
  update public.source_scans scans
     set status = 'failed',
         finished_at = now(),
         error_message = 'OLX worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted)
     and scans.status in ('pending', 'running');

  update public.olx_scan_jobs
     set status = 'queued',
         available_at = now(),
         leased_until = null,
         lease_token = null,
         worker_id = null,
         error_code = 'LEASE_RECOVERED',
         error_message = 'Previous worker lease expired'
   where status = 'running'
     and leased_until < now()
     and attempts < max_attempts;

  select * into claimed
    from public.olx_scan_jobs
   where status = 'queued'
     and available_at <= now()
   order by created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.olx_scan_jobs
     set status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         worker_id = p_worker_id,
         started_at = coalesce(started_at, now()),
         error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id
     and status = 'pending';

  return next claimed;
end;
$$;

alter table public.olx_scan_jobs enable row level security;
alter table public.olx_worker_nonces enable row level security;

revoke all on table public.olx_scan_jobs from anon, authenticated;
revoke all on table public.olx_worker_nonces from anon, authenticated;
revoke all on function public.claim_olx_scan_job(text, integer) from public, anon, authenticated;

grant select, insert, update, delete on table public.olx_scan_jobs to service_role;
grant select, insert, update, delete on table public.olx_worker_nonces to service_role;
grant execute on function public.claim_olx_scan_job(text, integer) to service_role;

commit;
