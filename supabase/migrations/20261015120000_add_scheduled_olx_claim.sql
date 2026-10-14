-- Draft only. Apply manually in the Supabase SQL Editor after review and
-- separate approval; never as part of a build or deployment.
--
-- Unattended OLX for Finder (docs/olx-cloud-scheduled.md). Purely additive.
--
-- 1. olx_automation_control: one row, the database STOP switch of the
--    scheduled Cloudflare claim. Created DISABLED. While disabled, nothing is
--    handed to the scheduled Worker, whatever its own configuration says.
-- 2. claim_scheduled_finder_olx_job(): the ONLY claim the scheduled Worker
--    uses. It hands out at most one job, and only one that the Finder OLX
--    schedule (enqueue_scheduled_finder_olx_job, PR #15) already admitted:
--      * context 'finder', requested_by 'scheduler', status 'queued',
--        attempts 0 (no retry of a job that already failed or lost its lease),
--        younger than the unclaimed expiry, filter active and still with OLX;
--      * never while ANY OLX job (Finder or Radar, any worker) is running with
--        a live lease: no parallel browser work on one Cloudflare account;
--      * at most p_max_claims_24h (0..1) scheduled claims per rolling 24 h;
--      * one advisory lock, FOR UPDATE SKIP LOCKED; no other row is changed
--        (no lease recovery, no exhaustion of other jobs, Radar untouched).
--    Returns jsonb { job, reason } so every refusal is diagnosable.
-- 3. expire_stale_scheduled_finder_olx_jobs(): marks automatic jobs that were
--    never claimed (or whose lease died) as failed with an explicit code.
--    History is kept: nothing is deleted, other jobs are untouched.
--
-- Rollback: scripts/olx-cloud-scheduled.rollback.sql
begin;

create table if not exists public.olx_automation_control (
  id smallint primary key default 1 check (id = 1),
  scheduled_claim_enabled boolean not null default false,
  unclaimed_expiry_minutes integer not null default 360 check (unclaimed_expiry_minutes between 30 and 1440),
  max_claims_24h integer not null default 1 check (max_claims_24h between 0 and 1),
  note text,
  updated_at timestamptz not null default now()
);

insert into public.olx_automation_control (id) values (1) on conflict (id) do nothing;

alter table public.olx_automation_control enable row level security;
revoke all on table public.olx_automation_control from public, anon, authenticated;
grant select, update on table public.olx_automation_control to service_role;

create or replace function public.claim_scheduled_finder_olx_job(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  control public.olx_automation_control%rowtype;
  claimed public.olx_scan_jobs%rowtype;
  claims_24h integer;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  select * into control from public.olx_automation_control where id = 1;
  if not found or not control.scheduled_claim_enabled then
    return jsonb_build_object('job', null, 'reason', 'AUTOMATION_DISABLED');
  end if;

  if exists (
    select 1 from public.olx_scan_jobs j
     where j.status = 'running' and j.leased_until > now()
  ) then
    return jsonb_build_object('job', null, 'reason', 'OLX_JOB_RUNNING');
  end if;

  select count(*) into claims_24h
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.requested_by = 'scheduler'
     and j.started_at >= now() - interval '24 hours';
  if claims_24h >= control.max_claims_24h then
    return jsonb_build_object('job', null, 'reason', 'DAILY_CLAIM_USED');
  end if;

  select j.* into claimed
    from public.olx_scan_jobs j
    join public.search_filters f on f.id = j.search_filter_id
   where j.status = 'queued'
     and j.context_type = 'finder'
     and j.requested_by = 'scheduler'
     and j.attempts = 0
     and j.available_at <= now()
     and j.created_at > now() - make_interval(mins => control.unclaimed_expiry_minutes)
     and f.is_active
     and coalesce(f.sources, '[]'::jsonb) ? 'olx'
   order by j.created_at
   limit 1
   for update of j skip locked;

  if claimed.id is null then
    return jsonb_build_object('job', null, 'reason', 'NO_DUE_JOB');
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

  return jsonb_build_object('job', to_jsonb(claimed), 'reason', null);
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

revoke all on function public.claim_scheduled_finder_olx_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_scheduled_finder_olx_job(text, integer) to service_role;
revoke all on function public.expire_stale_scheduled_finder_olx_jobs() from public, anon, authenticated;
grant execute on function public.expire_stale_scheduled_finder_olx_jobs() to service_role;

commit;
