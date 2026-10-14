-- Draft only. Apply manually in the Supabase SQL Editor after review and
-- separate approval; never as part of a build or deployment. Requires
-- 20261015120000 and 20261016120000 first; apply all three in one session.
--
-- Coordination of the three OLX claims (audit of PR #16,
-- docs/olx-claim-coordination.md):
--   claim_olx_scan_job            regular workers (local worker, manual scans)
--   claim_olx_scan_job_selective  stage2 controlled test (one named job)
--   claim_scheduled_finder_olx_job  scheduled Cloudflare Worker (automatic jobs)
--
-- Before this migration the first two took no lock shared with the third,
-- so a regular claim and a scheduled claim running at the same moment could
-- each start a job (the scheduled claim's "no live lease" check cannot see
-- an uncommitted claim). The regular claim also took automatic jobs
-- (requested_by = 'scheduler') like any other, and its lease recovery put an
-- automatic job whose lease expired back in the queue (an unauthorized retry).
--
-- 1. One lock. All three claims take the same transaction advisory lock
--    (key 'finder-olx-scheduled-claim', already used by the scheduled claim)
--    before reading anything, so they are serialized and each sees what the
--    previous one committed.
-- 2. Automatic jobs belong to the scheduled claim only. The regular and the
--    selective claim never select them; the regular claim's lease recovery
--    and exhaustion never touch them (expire_stale_scheduled_finder_olx_jobs
--    closes them with an explicit code).
-- 3. No parallel work of the old and the new Worker. The regular and the
--    selective claim hand out nothing while an automatic job holds a live
--    lease; the scheduled claim already hands out nothing while any job does.
--    Regular workers among themselves behave exactly as before (manual scans).
-- 4. Guard on automatic jobs (trigger): no retry (attempts never above 1,
--    never back to 'queued'), no revival of an expired lease (a late
--    heartbeat fails with OLX_SCHEDULED_JOB_LEASE_EXPIRED).
-- 5. STOP: while olx_automation_control.scheduled_claim_enabled is false,
--    expire_stale_scheduled_finder_olx_jobs retires queued automatic jobs at
--    once (OLX_SCHEDULED_JOB_STOPPED) instead of letting them wait 6 h for
--    OLX_SCHEDULED_JOB_NOT_CLAIMED. (The enqueue itself skips slots while the
--    switch is off: AUTOMATION_DISABLED, migration 20261016120000.)
--
-- Function signatures and return types are unchanged; running workers need
-- no new code. Nothing is deleted.
--
-- Rollback: scripts/olx-claim-coordination.rollback.sql
begin;

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

  -- Shared with claim_olx_scan_job_selective and claim_scheduled_finder_olx_job.
  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  -- Lease recovery as before, for every job except automatic ones.
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
       and requested_by is distinct from 'scheduler'
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
     and attempts < max_attempts
     and requested_by is distinct from 'scheduler';

  -- Never next to a running automatic job (one browser lane for old and new Worker).
  if exists (
    select 1 from public.olx_scan_jobs j
     where j.requested_by = 'scheduler' and j.status = 'running' and j.leased_until > now()
  ) then
    return;
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where status = 'queued'
     and available_at <= now()
     and requested_by is distinct from 'scheduler'
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

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  if exists (
    select 1 from public.olx_scan_jobs j
     where j.requested_by = 'scheduler' and j.status = 'running' and j.leased_until > now()
  ) then
    return;
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where id = p_job_id
     and status = 'queued'
     and context_type = 'finder'
     and requested_by is distinct from 'scheduler'
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

-- An automatic job runs at most once and only under its own live lease,
-- whatever path writes to it (old worker code, manual SQL, a late heartbeat).
create or replace function public.guard_scheduled_olx_job()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.requested_by is distinct from 'scheduler' then
    return new;
  end if;
  if new.attempts > 1 or (old.status <> 'queued' and new.status = 'queued') then
    raise exception 'OLX_SCHEDULED_JOB_NO_RETRY: automatic OLX job % is never retried or requeued', old.id;
  end if;
  if old.status = 'running' and new.status = 'running'
     and old.leased_until is not null and old.leased_until <= now()
     and new.leased_until is not null and new.leased_until > old.leased_until then
    raise exception 'OLX_SCHEDULED_JOB_LEASE_EXPIRED: the lease of automatic OLX job % expired and cannot be renewed', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists olx_scan_jobs_guard_scheduled on public.olx_scan_jobs;
create trigger olx_scan_jobs_guard_scheduled
before update on public.olx_scan_jobs
for each row execute function public.guard_scheduled_olx_job();

create or replace function public.expire_stale_scheduled_finder_olx_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  expiry_minutes integer;
  enabled boolean;
  stopped integer := 0;
  unclaimed integer := 0;
  lease_expired integer := 0;
begin
  select unclaimed_expiry_minutes, scheduled_claim_enabled into expiry_minutes, enabled
    from public.olx_automation_control where id = 1;
  expiry_minutes := coalesce(expiry_minutes, 360);
  enabled := coalesce(enabled, false);

  -- STOP: nothing will claim a queued automatic job; close it now, explicitly.
  if not enabled then
    with retired as (
      update public.olx_scan_jobs j
         set status = 'failed', finished_at = now(), leased_until = null,
             error_code = 'OLX_SCHEDULED_JOB_STOPPED',
             error_message = 'Automat OLX wyłączony (STOP) przed odbiorem zadania; nie uruchomiono, nie ponowiono, historia zachowana.'
       where j.context_type = 'finder' and j.requested_by = 'scheduler'
         and j.status = 'queued'
      returning j.source_scan_id
    ), scans as (
      update public.source_scans s
         set status = 'failed', finished_at = now(),
             error_message = 'OLX_SCHEDULED_JOB_STOPPED: automat OLX wyłączony przed odbiorem zadania'
       where s.id in (select source_scan_id from retired) and s.status in ('pending', 'running')
      returning 1
    )
    select count(*) into stopped from retired;
  end if;

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

  return jsonb_build_object('stopped', stopped, 'unclaimed_expired', unclaimed, 'lease_expired', lease_expired,
    'expiry_minutes', expiry_minutes, 'automation_enabled', enabled);
end;
$$;

revoke all on function public.claim_olx_scan_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job(text, integer) to service_role;
revoke all on function public.claim_olx_scan_job_selective(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job_selective(text, uuid, integer) to service_role;
revoke all on function public.guard_scheduled_olx_job() from public, anon, authenticated;
revoke all on function public.expire_stale_scheduled_finder_olx_jobs() from public, anon, authenticated;
grant execute on function public.expire_stale_scheduled_finder_olx_jobs() to service_role;

commit;
