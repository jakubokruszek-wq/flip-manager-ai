-- Rollback of supabase/migrations/20261017120000_coordinate_olx_claims.sql.
-- Run only after separate approval, after STOP (scripts/olx-cloud-scheduled.stop.sql)
-- and BEFORE scripts/olx-slot-schedule.rollback.sql / olx-cloud-scheduled.rollback.sql.
--
-- Restores, byte for byte, the claim_olx_scan_job of 20260810190000, the
-- claim_olx_scan_job_selective of 20261013180000 and the
-- expire_stale_scheduled_finder_olx_jobs of 20261015120000, and drops the
-- guard trigger. Jobs, slots and history stay. After this rollback the
-- regular claim again takes automatic jobs and recovers their leases, so keep
-- the automation STOPPED (or roll back 20261016/20261015 too).
begin;

drop trigger if exists olx_scan_jobs_guard_scheduled on public.olx_scan_jobs;
drop function if exists public.guard_scheduled_olx_job();

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


create or replace function public.claim_olx_scan_job_selective(
  p_worker_id text,
  p_job_id uuid,
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

  if p_job_id is null then
    raise exception 'job_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where id = p_job_id
     and status = 'queued'
     and context_type = 'finder'
     and available_at <= now()
     and attempts < max_attempts
   for update skip locked;

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


create or replace function public.expire_stale_scheduled_finder_olx_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expiry_minutes integer;
  unclaimed integer := 0;
  lease_expired integer := 0;
begin
  select unclaimed_expiry_minutes into expiry_minutes from public.olx_automation_control where id = 1;
  expiry_minutes := coalesce(expiry_minutes, 360);

  with expired as (
    update public.olx_scan_jobs j
       set status = 'failed', finished_at = now(), leased_until = null,
           error_code = 'OLX_SCHEDULED_JOB_NOT_CLAIMED',
           error_message = format('Automatyczne zadanie OLX nie zostało odebrane przez %s min; nie ponowiono, historia zachowana.', expiry_minutes)
     where j.context_type = 'finder' and j.requested_by = 'scheduler'
       and j.status = 'queued'
       and j.created_at <= now() - make_interval(mins => expiry_minutes)
    returning j.source_scan_id
  ), scans as (
    update public.source_scans s
       set status = 'failed', finished_at = now(),
           error_message = 'OLX_SCHEDULED_JOB_NOT_CLAIMED: automatyczne zadanie OLX nie zostało odebrane'
     where s.id in (select source_scan_id from expired) and s.status in ('pending', 'running')
    returning 1
  )
  select count(*) into unclaimed from expired;

  with expired as (
    update public.olx_scan_jobs j
       set status = 'failed', finished_at = now(), leased_until = null,
           error_code = 'OLX_SCHEDULED_JOB_LEASE_EXPIRED',
           error_message = 'Worker przestał odnawiać lease automatycznego zadania OLX; nie ponowiono, historia zachowana.'
     where j.context_type = 'finder' and j.requested_by = 'scheduler'
       and j.status = 'running'
       and j.leased_until < now() - interval '10 minutes'
    returning j.source_scan_id
  ), scans as (
    update public.source_scans s
       set status = 'failed', finished_at = now(),
           error_message = 'OLX_SCHEDULED_JOB_LEASE_EXPIRED: worker przestał odnawiać lease'
     where s.id in (select source_scan_id from expired) and s.status in ('pending', 'running')
    returning 1
  )
  select count(*) into lease_expired from expired;

  return jsonb_build_object('unclaimed_expired', unclaimed, 'lease_expired', lease_expired, 'expiry_minutes', expiry_minutes);
end;
$$;


revoke all on function public.claim_olx_scan_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job(text, integer) to service_role;
revoke all on function public.claim_olx_scan_job_selective(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job_selective(text, uuid, integer) to service_role;
revoke all on function public.expire_stale_scheduled_finder_olx_jobs() from public, anon, authenticated;
grant execute on function public.expire_stale_scheduled_finder_olx_jobs() to service_role;

commit;
