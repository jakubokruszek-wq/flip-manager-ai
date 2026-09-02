begin;

alter table public.facebook_scan_jobs
  add column if not exists consumer_type text;

update public.facebook_scan_jobs
   set consumer_type = 'LEGACY_WORKER'
 where consumer_type is null;

alter table public.facebook_scan_jobs
  alter column consumer_type set default 'LEGACY_WORKER',
  alter column consumer_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'facebook_scan_jobs_consumer_type_check'
       and conrelid = 'public.facebook_scan_jobs'::regclass
  ) then
    alter table public.facebook_scan_jobs
      add constraint facebook_scan_jobs_consumer_type_check
      check (consumer_type in ('BROWSER_EXTENSION', 'LEGACY_WORKER'));
  end if;
end;
$$;

create index if not exists facebook_scan_jobs_consumer_claim_idx
  on public.facebook_scan_jobs (consumer_type, status, available_at, created_at)
  where status = 'queued';

drop function if exists public.claim_facebook_scan_job(text, integer);

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
    update public.facebook_scan_jobs
       set status = 'failed', finished_at = now(), leased_until = null,
           lease_token = null, error_code = 'LEASE_EXHAUSTED',
           error_message = 'Facebook worker lease expired after maximum attempts'
     where status = 'running' and leased_until < now() and attempts >= max_attempts
     returning source_scan_id
  )
  update public.source_scans scans
     set status = 'failed', finished_at = now(),
         error_message = 'Facebook worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted)
     and scans.status in ('pending', 'running');

  update public.facebook_scan_jobs
     set status = 'queued', available_at = now(), leased_until = null,
         lease_token = null, worker_id = null, error_code = 'LEASE_RECOVERED',
         error_message = 'Previous Facebook worker lease expired'
   where status = 'running' and leased_until < now() and attempts < max_attempts;

  select * into claimed
    from public.facebook_scan_jobs
   where status = 'queued'
     and consumer_type = p_consumer_type
     and available_at <= now()
     and attempts < max_attempts
   order by created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.facebook_scan_jobs
     set status = 'running', attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), worker_id = p_worker_id,
         started_at = coalesce(started_at, now()), error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id and status = 'pending';

  return next claimed;
end;
$$;

revoke all on function public.claim_facebook_scan_job(text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_facebook_scan_job(text, integer, text) to service_role;

commit;
