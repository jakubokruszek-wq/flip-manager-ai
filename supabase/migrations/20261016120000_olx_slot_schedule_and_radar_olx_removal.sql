-- Draft only. Apply manually in the Supabase SQL Editor after review and
-- separate approval; never as part of a build or deployment. Requires
-- 20261014120000 (PR #15) and 20261015120000 (scheduled claim) first.
--
-- docs/olx-slot-schedule.md. Three parts:
--
-- A. Finder OLX schedule in fixed time slots (Europe/Warsaw wall clock)
--    * search_filters.finder_olx_start_time (HH:mm, 5-minute steps, default
--      08:00) and finder_olx_schedule_anchor (local wall-clock timestamp of
--      the first slot, set by a trigger whenever the interval or start time
--      changes; durable, so 48/72 h slots never drift after a delay).
--    * Intervals 12/24/48/72 h. Slots are anchor + k * interval on the WALL
--      CLOCK, so 08:00 stays 08:00 across the DST changes.
--    * finder_olx_slots: one row per (filter, slot) once the slot is decided
--      (enqueued or missed): the primary key deduplicates every slot, also
--      against concurrent scheduler calls (advisory lock + PK + slot-based
--      idempotency key of the job).
--    * Only the CURRENT slot is ever considered, and only within its grace
--      (min(3 h, interval / 2)); after a restart or an outage older slots are
--      not caught up (no avalanche), the current one is recorded as missed.
--    * STOP (olx_automation_control.scheduled_claim_enabled = false): no job
--      is queued (nothing would claim it); the slot waits with the blocker
--      AUTOMATION_DISABLED and, past its grace, is recorded once as missed
--      with that reason. Switching on within the grace still runs the slot.
-- B. Up to 2 automatic OLX jobs per rolling 24 h, gated by real browser time
--    * olx_automation_control.max_claims_24h may be 0..2 (stays 1 until the
--      operator raises it after the budget check); the enqueue and the claim
--      read the same value. Manual Finder scans share the budget
--      (effective shared limit = greatest(p_shared_limit, automatic limit)).
--    * olx_cloud_budget: the scheduled Worker reports, with every claim, the
--      account's Browser Run time today (history()), its own ledger, its safe
--      budget and the measured cost of its last job. A slot whose job would
--      not fit is skipped as BROWSER_BUDGET_INSUFFICIENT; a claim without a
--      usable report is refused (BROWSER_USAGE_UNKNOWN).
-- C. OLX removed from Price Radar
--    * Trigger: a price_radar OLX job can no longer be inserted, and any
--      transition of one to queued/running (requeue on Radar claim, STOP
--      resume, worker claim, heartbeat) turns it into failed
--      RADAR_OLX_REMOVED with an audit entry instead.
--    * Pending/running Radar OLX jobs are retired the same way now. Nothing is
--      deleted; price_radar_listings rows from OLX stay as history (the
--      application no longer counts them).
--
-- Rollback: scripts/olx-slot-schedule.rollback.sql
begin;

-- ---------------------------------------------------------------- C. Radar
create or replace function public.block_price_radar_olx_jobs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.context_type is distinct from 'price_radar' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'RADAR_OLX_REMOVED: OLX is a Flip Finder-only source; Price Radar cannot queue OLX jobs';
  end if;
  if new.status in ('queued', 'running') then
    new.result_summary := coalesce(old.result_summary, '{}'::jsonb) || jsonb_build_object('radarOlxRemoved', jsonb_build_object(
      'at', now(), 'blockedTransition', old.status || '->' || new.status, 'previousErrorCode', old.error_code));
    new.status := 'failed';
    new.finished_at := now();
    new.lease_token := null;
    new.leased_until := null;
    new.error_code := 'RADAR_OLX_REMOVED';
    new.error_message := 'OLX usunięty z Radaru cen (tylko Flip Finder); zadania nie uruchomiono ani nie wznowiono.';
  end if;
  return new;
end;
$$;

drop trigger if exists olx_scan_jobs_block_price_radar on public.olx_scan_jobs;
create trigger olx_scan_jobs_block_price_radar
before insert or update on public.olx_scan_jobs
for each row execute function public.block_price_radar_olx_jobs();

update public.olx_scan_jobs j
   set status = 'failed', finished_at = now(), lease_token = null, leased_until = null,
       error_code = 'RADAR_OLX_REMOVED',
       error_message = 'OLX usunięty z Radaru cen (tylko Flip Finder); oczekujące zadanie wycofane bez uruchamiania.',
       result_summary = coalesce(j.result_summary, '{}'::jsonb) || jsonb_build_object('radarOlxRemoved', jsonb_build_object(
         'at', now(), 'retiredFromStatus', j.status, 'previousErrorCode', j.error_code))
 where j.context_type = 'price_radar' and j.status in ('queued', 'running');

-- ------------------------------------------------------------ A. Slots
alter table public.search_filters
  add column if not exists finder_olx_start_time time not null default '08:00';
alter table public.search_filters
  add column if not exists finder_olx_schedule_anchor timestamp;

alter table public.search_filters drop constraint if exists search_filters_finder_olx_scan_interval_min;
alter table public.search_filters drop constraint if exists search_filters_finder_olx_scan_interval_allowed;
alter table public.search_filters
  add constraint search_filters_finder_olx_scan_interval_allowed
  check (finder_olx_scan_interval_minutes in (720, 1440, 2880, 4320));
alter table public.search_filters drop constraint if exists search_filters_finder_olx_start_time_step;
alter table public.search_filters
  add constraint search_filters_finder_olx_start_time_step
  check (extract(second from finder_olx_start_time) = 0 and extract(minute from finder_olx_start_time)::integer % 5 = 0);

-- First slot at or after p_now (Europe/Warsaw wall clock): the next
-- occurrence of the start time, or of start time + 12 h for a 12 h interval.
create or replace function public.finder_olx_first_slot(p_start_time time, p_interval_minutes integer, p_now timestamptz)
returns timestamp
language sql
stable
set search_path = public
as $$
  with clock as (
    select (p_now at time zone 'Europe/Warsaw') as wall_now,
           ((p_now at time zone 'Europe/Warsaw')::date + p_start_time) as base,
           least(p_interval_minutes, 1440) * 60 as step_seconds
  )
  select base + make_interval(secs => step_seconds * ceil(greatest(0, extract(epoch from (wall_now - base))) / step_seconds))
    from clock;
$$;

-- Current (latest started) and next slot of a schedule at p_now.
create or replace function public.finder_olx_slot_window(p_anchor timestamp, p_interval_minutes integer, p_now timestamptz)
returns table (current_slot timestamptz, next_slot timestamptz, current_local timestamp, next_local timestamp)
language plpgsql
stable
set search_path = public
as $$
declare
  wall_now timestamp := p_now at time zone 'Europe/Warsaw';
  k bigint;
begin
  if p_anchor is null or p_interval_minutes is null or p_interval_minutes <= 0 then
    return;
  end if;
  if wall_now < p_anchor then
    current_slot := null; current_local := null;
    next_local := p_anchor;
  else
    k := floor(extract(epoch from (wall_now - p_anchor)) / (p_interval_minutes * 60));
    current_local := p_anchor + make_interval(mins => (k * p_interval_minutes)::integer);
    next_local := current_local + make_interval(mins => p_interval_minutes);
    current_slot := current_local at time zone 'Europe/Warsaw';
  end if;
  next_slot := next_local at time zone 'Europe/Warsaw';
  return next;
end;
$$;

create or replace function public.set_finder_olx_schedule_anchor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or old.finder_olx_schedule_anchor is null
     or new.finder_olx_scan_interval_minutes is distinct from old.finder_olx_scan_interval_minutes
     or new.finder_olx_start_time is distinct from old.finder_olx_start_time then
    new.finder_olx_schedule_anchor := public.finder_olx_first_slot(new.finder_olx_start_time, new.finder_olx_scan_interval_minutes, now());
  elsif new.finder_olx_schedule_anchor is distinct from old.finder_olx_schedule_anchor then
    -- The anchor is durable: only a schedule change moves it.
    new.finder_olx_schedule_anchor := old.finder_olx_schedule_anchor;
  end if;
  return new;
end;
$$;

drop trigger if exists search_filters_finder_olx_anchor on public.search_filters;
create trigger search_filters_finder_olx_anchor
before insert or update on public.search_filters
for each row execute function public.set_finder_olx_schedule_anchor();

update public.search_filters
   set finder_olx_schedule_anchor = public.finder_olx_first_slot(finder_olx_start_time, finder_olx_scan_interval_minutes, now())
 where finder_olx_schedule_anchor is null;
alter table public.search_filters alter column finder_olx_schedule_anchor set not null;

create table if not exists public.finder_olx_slots (
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  slot_at timestamptz not null,
  status text not null check (status in ('enqueued', 'missed')),
  reason text,
  job_id uuid references public.olx_scan_jobs(id) on delete set null,
  decided_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  primary key (search_filter_id, slot_at)
);
alter table public.finder_olx_slots enable row level security;
revoke all on table public.finder_olx_slots from public, anon, authenticated;
grant select, insert on table public.finder_olx_slots to service_role;

-- ------------------------------------------- B. 2 per 24 h + browser budget
alter table public.olx_automation_control drop constraint if exists olx_automation_control_max_claims_24h_check;
alter table public.olx_automation_control
  add constraint olx_automation_control_max_claims_24h_check check (max_claims_24h between 0 and 2);

create table if not exists public.olx_cloud_budget (
  worker_id text primary key check (length(worker_id) between 3 and 100),
  reported_at timestamptz not null default now(),
  utc_day date not null,
  account_browser_ms integer not null check (account_browser_ms >= 0),
  worker_browser_ms integer not null check (worker_browser_ms >= 0),
  safe_budget_ms integer not null check (safe_budget_ms between 0 and 600000),
  job_estimate_ms integer not null check (job_estimate_ms between 0 and 600000)
);
alter table public.olx_cloud_budget enable row level security;
revoke all on table public.olx_cloud_budget from public, anon, authenticated;
grant select on table public.olx_cloud_budget to service_role;

-- Latest usable report of today (UTC, when Browser Run resets), or nothing.
create or replace function public.olx_cloud_budget_today(p_now timestamptz)
returns table (worker_id text, reported_at timestamptz, account_browser_ms integer, worker_browser_ms integer, safe_budget_ms integer, job_estimate_ms integer, remaining_ms integer, fits_one_job boolean)
language sql
stable
set search_path = public
as $$
  select b.worker_id, b.reported_at, b.account_browser_ms, b.worker_browser_ms, b.safe_budget_ms, b.job_estimate_ms,
         greatest(0, b.safe_budget_ms - greatest(b.account_browser_ms, b.worker_browser_ms)) as remaining_ms,
         greatest(b.account_browser_ms, b.worker_browser_ms) + b.job_estimate_ms <= b.safe_budget_ms as fits_one_job
    from public.olx_cloud_budget b
   where b.utc_day = (p_now at time zone 'UTC')::date
   order by b.reported_at desc
   limit 1;
$$;

create or replace function public.enqueue_scheduled_finder_olx_job(
  p_filter_id uuid,
  p_run_id uuid,
  p_request_url text,
  p_filter_snapshot jsonb,
  p_shared_limit integer default 1,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_length constant interval := interval '24 hours';
  checked_at timestamptz := now();
  window_start timestamptz := checked_at - window_length;
  filter_row public.search_filters%rowtype;
  interval_minutes integer;
  grace interval;
  slot record;
  slot_row public.finder_olx_slots%rowtype;
  last_slot jsonb;
  last_job record;
  in_flight integer;
  automatic_limit integer;
  automation_enabled boolean;
  effective_shared integer;
  automatic_count integer;
  finder_other_count integer;
  radar_count integer;
  cloudflare_count integer;
  total_count integer;
  oldest_automatic timestamptz;
  shared_release timestamptz;
  budget record;
  budget_json jsonb := null;
  blocker text := null;
  reason text := null;
  next_allowed timestamptz;
  new_scan_id uuid;
  new_job_id uuid;
  slot_key text;
begin
  if p_shared_limit is null or p_shared_limit < 1 or p_shared_limit > 20 then
    raise exception 'p_shared_limit must be between 1 and 20';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-automatic-schedule', 0));

  select * into filter_row from public.search_filters where id = p_filter_id for update;
  if not found then
    return jsonb_build_object('decision', 'skipped', 'reason', 'FILTER_NOT_FOUND', 'checked_at', checked_at);
  end if;
  interval_minutes := filter_row.finder_olx_scan_interval_minutes;
  grace := make_interval(mins => least(180, interval_minutes / 2));
  select * into slot from public.finder_olx_slot_window(filter_row.finder_olx_schedule_anchor, interval_minutes, checked_at);
  if slot.current_slot is not null then
    select * into slot_row from public.finder_olx_slots s where s.search_filter_id = p_filter_id and s.slot_at = slot.current_slot;
  end if;

  select coalesce((select c.max_claims_24h from public.olx_automation_control c where c.id = 1), 1) into automatic_limit;
  select coalesce((select c.scheduled_claim_enabled from public.olx_automation_control c where c.id = 1), false) into automation_enabled;
  effective_shared := greatest(p_shared_limit, automatic_limit);

  select
    count(*) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler'),
    count(*) filter (where j.context_type = 'finder' and j.requested_by is distinct from 'scheduler'),
    count(*) filter (where j.context_type = 'price_radar'),
    count(*) filter (where coalesce(j.worker_id, '') like 'cloudflare%'),
    count(*),
    min(j.created_at) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler')
    into automatic_count, finder_other_count, radar_count, cloudflare_count, total_count, oldest_automatic
    from public.olx_scan_jobs j
   where (j.created_at >= window_start or j.started_at >= window_start)
     -- Retired Radar jobs never ran in the window; they do not use the budget.
     and not (j.context_type = 'price_radar' and j.error_code = 'RADAR_OLX_REMOVED' and j.started_at is null);

  select j.created_at, j.status, j.requested_by into last_job
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.search_filter_id = p_filter_id
   order by j.created_at desc limit 1;

  select count(*) into in_flight from (
    select 1 from public.olx_scan_jobs j
     where j.context_type = 'finder' and j.search_filter_id = p_filter_id and j.status in ('queued', 'running')
    union all
    select 1 from public.source_scans s
     where s.search_filter_id = p_filter_id and s.source = 'olx' and s.status in ('pending', 'running')
  ) pending;

  if total_count >= effective_shared then
    select greatest(j.created_at, coalesce(j.started_at, j.created_at)) + window_length into shared_release
      from public.olx_scan_jobs j
     where (j.created_at >= window_start or j.started_at >= window_start)
       and not (j.context_type = 'price_radar' and j.error_code = 'RADAR_OLX_REMOVED' and j.started_at is null)
     order by greatest(j.created_at, coalesce(j.started_at, j.created_at)) asc
     offset (total_count - effective_shared) limit 1;
  end if;

  select * into budget from public.olx_cloud_budget_today(checked_at);
  if budget.worker_id is not null then
    budget_json := jsonb_build_object('reported_at', budget.reported_at, 'account_browser_ms', budget.account_browser_ms,
      'worker_browser_ms', budget.worker_browser_ms, 'safe_budget_ms', budget.safe_budget_ms, 'job_estimate_ms', budget.job_estimate_ms,
      'remaining_ms', budget.remaining_ms, 'fits_one_job', budget.fits_one_job);
  end if;

  select jsonb_build_object('slot_at', s.slot_at, 'status', s.status, 'reason', s.reason, 'decided_at', s.decided_at, 'job_id', s.job_id,
           'job_status', j.status, 'job_error_code', j.error_code, 'started_at', j.started_at, 'finished_at', j.finished_at,
           'worker_id', j.worker_id, 'delay_seconds', case when j.started_at is null then null else round(extract(epoch from (j.started_at - s.slot_at)))::integer end)
    into last_slot
    from public.finder_olx_slots s left join public.olx_scan_jobs j on j.id = s.job_id
   where s.search_filter_id = p_filter_id
   order by s.slot_at desc limit 1;

  if not filter_row.is_active then
    reason := 'FILTER_INACTIVE';
  elsif not (coalesce(filter_row.sources, '[]'::jsonb) ? 'olx') then
    reason := 'OLX_NOT_SELECTED';
  elsif slot.current_slot is null then
    reason := 'BEFORE_FIRST_SLOT';
  elsif slot_row.slot_at is not null then
    reason := 'SLOT_ALREADY_HANDLED';
  else
    if not automation_enabled then
      -- STOP: nothing would claim the job. Queue nothing (no job that can only
      -- end as NOT_CLAIMED, no use of the shared budget); past the grace the
      -- slot is recorded once as missed with this reason.
      blocker := 'AUTOMATION_DISABLED';
    elsif in_flight > 0 then
      blocker := 'OLX_JOB_IN_FLIGHT';
    elsif automatic_count >= automatic_limit then
      blocker := 'AUTOMATIC_DAILY_BUDGET_USED';
    elsif total_count >= effective_shared then
      blocker := 'SHARED_DAILY_BUDGET_USED';
    elsif budget.worker_id is not null and not budget.fits_one_job then
      blocker := 'BROWSER_BUDGET_INSUFFICIENT';
    elsif exists (
      -- Fairness for one shared budget: another active OLX filter whose own
      -- current slot is open and undecided, with an older last OLX order, goes first.
      select 1
        from public.search_filters f
        cross join lateral public.finder_olx_slot_window(f.finder_olx_schedule_anchor, f.finder_olx_scan_interval_minutes, checked_at) w
        left join lateral (select max(j.created_at) as last_at from public.olx_scan_jobs j where j.context_type = 'finder' and j.search_filter_id = f.id) other_last on true
       where f.id <> p_filter_id and f.is_active and coalesce(f.sources, '[]'::jsonb) ? 'olx'
         and w.current_slot is not null
         and checked_at <= w.current_slot + make_interval(mins => least(180, f.finder_olx_scan_interval_minutes / 2))
         and not exists (select 1 from public.finder_olx_slots s where s.search_filter_id = f.id and s.slot_at = w.current_slot)
         and coalesce(other_last.last_at, '-infinity'::timestamptz) < coalesce(last_job.created_at, '-infinity'::timestamptz)
         and not exists (select 1 from public.olx_scan_jobs j where j.context_type = 'finder' and j.search_filter_id = f.id and j.status in ('queued', 'running'))
         and not exists (select 1 from public.source_scans s where s.search_filter_id = f.id and s.source = 'olx' and s.status in ('pending', 'running'))
    ) then
      blocker := 'ANOTHER_FILTER_FIRST';
    end if;

    if checked_at > slot.current_slot + grace then
      -- Too late for this slot: record it once as missed, never catch it up.
      reason := 'SLOT_MISSED';
      if not p_dry_run then
        insert into public.finder_olx_slots (search_filter_id, slot_at, status, reason, details)
        values (p_filter_id, slot.current_slot, 'missed', coalesce(blocker, 'NOT_ENQUEUED_WITHIN_GRACE'),
                jsonb_build_object('grace_minutes', extract(epoch from grace) / 60, 'checked_at', checked_at))
        on conflict do nothing;
      end if;
    else
      reason := blocker;
    end if;
  end if;

  if reason is null and not p_dry_run then
    if p_request_url is null or p_request_url !~ '^https://(www\.)?olx\.pl/' then
      raise exception 'invalid OLX request url';
    end if;
    if p_filter_snapshot is null or jsonb_typeof(p_filter_snapshot) <> 'object' then
      raise exception 'invalid filter snapshot';
    end if;
    slot_key := p_filter_id::text || ':olx-slot:' || floor(extract(epoch from slot.current_slot))::bigint::text;
    insert into public.source_scans (search_filter_id, source, status, scan_run_id, filter_snapshot)
    values (p_filter_id, 'olx', 'pending', p_run_id, p_filter_snapshot)
    returning id into new_scan_id;
    insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, filter_snapshot, idempotency_key, requested_by)
    values (p_run_id, new_scan_id, p_filter_id, p_request_url, p_filter_snapshot, slot_key, 'scheduler')
    returning id into new_job_id;
    insert into public.finder_olx_slots (search_filter_id, slot_at, status, job_id, details)
    values (p_filter_id, slot.current_slot, 'enqueued', new_job_id, jsonb_build_object('run_id', p_run_id, 'checked_at', checked_at));
    automatic_count := automatic_count + 1;
    total_count := total_count + 1;
    last_slot := jsonb_build_object('slot_at', slot.current_slot, 'status', 'enqueued', 'reason', null, 'decided_at', checked_at, 'job_id', new_job_id,
      'job_status', 'queued', 'job_error_code', null, 'started_at', null, 'finished_at', null, 'worker_id', null, 'delay_seconds', null);
  end if;

  if reason is null or reason in ('SLOT_ALREADY_HANDLED', 'SLOT_MISSED', 'BEFORE_FIRST_SLOT') then
    next_allowed := slot.next_slot;
  elsif reason = 'AUTOMATION_DISABLED' then
    -- Switching the automation on within the grace still runs this slot.
    next_allowed := case when checked_at <= slot.current_slot + grace then checked_at else slot.next_slot end;
  elsif reason in ('OLX_JOB_IN_FLIGHT', 'AUTOMATIC_DAILY_BUDGET_USED', 'SHARED_DAILY_BUDGET_USED', 'BROWSER_BUDGET_INSUFFICIENT', 'ANOTHER_FILTER_FIRST') then
    next_allowed := greatest(checked_at,
      case when automatic_count >= automatic_limit then oldest_automatic + window_length else checked_at end,
      coalesce(shared_release, checked_at));
    -- Past this slot's grace the next chance is the next slot.
    if next_allowed > slot.current_slot + grace then next_allowed := slot.next_slot; end if;
  else
    next_allowed := null;
  end if;

  return jsonb_build_object(
    'decision', case when reason is not null then 'skipped' when p_dry_run then 'due' else 'enqueued' end,
    'reason', reason,
    'blocker', blocker,
    'checked_at', checked_at,
    'interval_minutes', interval_minutes,
    'start_time', to_char(filter_row.finder_olx_start_time, 'HH24:MI'),
    'time_zone', 'Europe/Warsaw',
    'anchor_local', to_char(filter_row.finder_olx_schedule_anchor, 'YYYY-MM-DD"T"HH24:MI'),
    'slot_at', slot.current_slot,
    'slot_local', to_char(slot.current_local, 'YYYY-MM-DD"T"HH24:MI'),
    'next_slot_at', slot.next_slot,
    'next_slot_local', to_char(slot.next_local, 'YYYY-MM-DD"T"HH24:MI'),
    'grace_until', case when slot.current_slot is null then null else slot.current_slot + grace end,
    'job_id', new_job_id,
    'source_scan_id', new_scan_id,
    'run_id', case when new_job_id is null then null else p_run_id end,
    'last_job_at', last_job.created_at,
    'last_job_status', last_job.status,
    'last_job_automatic', coalesce(last_job.requested_by = 'scheduler', false),
    'last_slot', last_slot,
    'next_allowed_at', next_allowed,
    'window_hours', 24,
    'automatic_jobs_in_window', automatic_count,
    'automatic_limit', automatic_limit,
    'finder_other_jobs_in_window', finder_other_count,
    'radar_jobs_in_window', radar_count,
    'cloudflare_jobs_in_window', cloudflare_count,
    'total_jobs_in_window', total_count,
    'shared_limit', effective_shared,
    'automation_enabled', automation_enabled,
    'browser_budget', budget_json
  );
end;
$$;

-- Claim of the scheduled Worker with its usage report (see 20261015120000 for
-- the rules shared with the 2-argument version, which stays for rollback).
create or replace function public.claim_scheduled_finder_olx_job(
  p_worker_id text,
  p_lease_seconds integer,
  p_usage jsonb
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
  account_ms integer;
  worker_ms integer;
  safe_ms integer;
  estimate_ms integer;
  budget_json jsonb;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 or length(p_worker_id) > 100 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  select * into control from public.olx_automation_control where id = 1;
  if not found or not control.scheduled_claim_enabled then
    return jsonb_build_object('job', null, 'reason', 'AUTOMATION_DISABLED');
  end if;

  -- Usage report: all four numbers must be present, finite and in range;
  -- anything else (missing, string, negative, NULL) is "unknown" = no claim.
  if not coalesce(
       jsonb_typeof(p_usage) = 'object'
       and jsonb_typeof(p_usage->'accountBrowserMs') = 'number' and jsonb_typeof(p_usage->'workerBrowserMs') = 'number'
       and jsonb_typeof(p_usage->'safeBudgetMs') = 'number' and jsonb_typeof(p_usage->'jobEstimateMs') = 'number'
       and (p_usage->>'accountBrowserMs')::numeric between 0 and 86400000
       and (p_usage->>'workerBrowserMs')::numeric between 0 and 86400000
       and (p_usage->>'safeBudgetMs')::numeric between 0 and 86400000
       and (p_usage->>'jobEstimateMs')::numeric > 0 and (p_usage->>'jobEstimateMs')::numeric <= 86400000,
     false) then
    return jsonb_build_object('job', null, 'reason', 'BROWSER_USAGE_UNKNOWN');
  end if;
  account_ms := round((p_usage->>'accountBrowserMs')::numeric);
  worker_ms := round((p_usage->>'workerBrowserMs')::numeric);
  -- Never trust a budget above half of the Workers Free daily allowance.
  safe_ms := least(round((p_usage->>'safeBudgetMs')::numeric)::integer, 300000);
  estimate_ms := least(round((p_usage->>'jobEstimateMs')::numeric)::integer, 600000);

  insert into public.olx_cloud_budget as b (worker_id, reported_at, utc_day, account_browser_ms, worker_browser_ms, safe_budget_ms, job_estimate_ms)
  values (p_worker_id, now(), (now() at time zone 'UTC')::date, least(account_ms, 600000), least(worker_ms, 600000), safe_ms, estimate_ms)
  on conflict (worker_id) do update set reported_at = excluded.reported_at, utc_day = excluded.utc_day,
    account_browser_ms = excluded.account_browser_ms, worker_browser_ms = excluded.worker_browser_ms,
    safe_budget_ms = excluded.safe_budget_ms, job_estimate_ms = excluded.job_estimate_ms;
  budget_json := jsonb_build_object('account_browser_ms', account_ms, 'worker_browser_ms', worker_ms, 'safe_budget_ms', safe_ms, 'job_estimate_ms', estimate_ms);

  if greatest(account_ms, worker_ms) + estimate_ms > safe_ms then
    return jsonb_build_object('job', null, 'reason', 'BROWSER_BUDGET_INSUFFICIENT', 'budget', budget_json);
  end if;

  if exists (select 1 from public.olx_scan_jobs j where j.status = 'running' and j.leased_until > now()) then
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
     set status = 'running', attempts = attempts + 1, lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(),
         worker_id = p_worker_id, started_at = coalesce(started_at, now()), error_code = null, error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans set status = 'running', error_message = null
   where id = claimed.source_scan_id and status = 'pending';

  return jsonb_build_object('job', to_jsonb(claimed), 'reason', null, 'budget', budget_json);
end;
$$;

revoke all on function public.claim_scheduled_finder_olx_job(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_scheduled_finder_olx_job(text, integer, jsonb) to service_role;
revoke all on function public.finder_olx_first_slot(time, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.finder_olx_slot_window(timestamp, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.olx_cloud_budget_today(timestamptz) from public, anon, authenticated;
grant execute on function public.finder_olx_first_slot(time, integer, timestamptz) to service_role;
grant execute on function public.finder_olx_slot_window(timestamp, integer, timestamptz) to service_role;
grant execute on function public.olx_cloud_budget_today(timestamptz) to service_role;

commit;
