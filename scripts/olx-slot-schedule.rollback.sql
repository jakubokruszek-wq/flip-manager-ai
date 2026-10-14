-- Rollback of supabase/migrations/20261016120000_olx_slot_schedule_and_radar_olx_removal.sql.
-- Run by hand in the Supabase SQL Editor, AFTER: (1) STOP of unattended OLX
-- (scripts/olx-cloud-scheduled.stop.sql + workflow "disable"), (2) revert of
-- the application code. Nothing is deleted from olx_scan_jobs, source_scans
-- or price_radar_*; the slot history table and the budget reports are dropped.
--
-- Not reversed on purpose: Radar OLX jobs retired as RADAR_OLX_REMOVED stay
-- failed (they are history; re-queuing them would restart Radar OLX scans).
-- After this rollback Radar COULD queue OLX again only with reverted code.
begin;

drop trigger if exists olx_scan_jobs_block_price_radar on public.olx_scan_jobs;
drop function if exists public.block_price_radar_olx_jobs();

drop function if exists public.claim_scheduled_finder_olx_job(text, integer, jsonb);
drop function if exists public.olx_cloud_budget_today(timestamptz);
drop table if exists public.olx_cloud_budget;
update public.olx_automation_control set max_claims_24h = least(max_claims_24h, 1);
alter table public.olx_automation_control drop constraint if exists olx_automation_control_max_claims_24h_check;
alter table public.olx_automation_control
  add constraint olx_automation_control_max_claims_24h_check check (max_claims_24h between 0 and 1);

drop table if exists public.finder_olx_slots;
drop trigger if exists search_filters_finder_olx_anchor on public.search_filters;
drop function if exists public.set_finder_olx_schedule_anchor();
drop function if exists public.finder_olx_slot_window(timestamp, integer, timestamptz);
drop function if exists public.finder_olx_first_slot(time, integer, timestamptz);
alter table public.search_filters drop constraint if exists search_filters_finder_olx_start_time_step;
alter table public.search_filters drop constraint if exists search_filters_finder_olx_scan_interval_allowed;
-- 12 h did not exist before: such filters return to 24 h.
update public.search_filters set finder_olx_scan_interval_minutes = 1440 where finder_olx_scan_interval_minutes < 1440;
alter table public.search_filters
  add constraint search_filters_finder_olx_scan_interval_min check (finder_olx_scan_interval_minutes >= 1440);
alter table public.search_filters drop column if exists finder_olx_schedule_anchor;
alter table public.search_filters drop column if exists finder_olx_start_time;

-- The PR #15 decision function, verbatim (interval counted from the last order).
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
  automatic_limit constant integer := 1;
  window_length constant interval := interval '24 hours';
  checked_at timestamptz := now();
  window_start timestamptz := checked_at - window_length;
  filter_row public.search_filters%rowtype;
  interval_minutes integer;
  in_flight integer;
  last_job record;
  automatic_count integer;
  finder_other_count integer;
  radar_count integer;
  cloudflare_count integer;
  total_count integer;
  oldest_automatic timestamptz;
  shared_release timestamptz;
  next_allowed timestamptz;
  reason text := null;
  new_scan_id uuid;
  new_job_id uuid;
begin
  if p_shared_limit is null or p_shared_limit < 1 or p_shared_limit > 20 then
    raise exception 'p_shared_limit must be between 1 and 20';
  end if;

  -- One global gate for every automatic OLX decision (all filters share one
  -- Cloudflare account). Held until the end of this transaction.
  perform pg_advisory_xact_lock(hashtextextended('finder-olx-automatic-schedule', 0));

  select * into filter_row from public.search_filters where id = p_filter_id for update;
  if not found then
    return jsonb_build_object('decision', 'skipped', 'reason', 'FILTER_NOT_FOUND', 'checked_at', checked_at);
  end if;
  interval_minutes := filter_row.finder_olx_scan_interval_minutes;

  -- Durable usage of the shared OLX queue in the rolling window. A job counts
  -- from the moment it was ordered or claimed (a Radar job re-queued and
  -- claimed again is counted again), whatever its final status: a failed or
  -- abandoned job does not give its budget back.
  select
    count(*) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler'),
    count(*) filter (where j.context_type = 'finder' and j.requested_by is distinct from 'scheduler'),
    count(*) filter (where j.context_type = 'price_radar'),
    count(*) filter (where coalesce(j.worker_id, '') like 'cloudflare%'),
    count(*),
    min(j.created_at) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler')
    into automatic_count, finder_other_count, radar_count, cloudflare_count, total_count, oldest_automatic
    from public.olx_scan_jobs j
   where j.created_at >= window_start or j.started_at >= window_start;

  select j.created_at, j.status, j.requested_by
    into last_job
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.search_filter_id = p_filter_id
   order by j.created_at desc
   limit 1;

  select count(*) into in_flight
    from (
      select 1 from public.olx_scan_jobs j
       where j.context_type = 'finder' and j.search_filter_id = p_filter_id and j.status in ('queued', 'running')
      union all
      select 1 from public.source_scans s
       where s.search_filter_id = p_filter_id and s.source = 'olx' and s.status in ('pending', 'running')
    ) pending;

  if total_count >= p_shared_limit then
    select greatest(j.created_at, coalesce(j.started_at, j.created_at)) + window_length
      into shared_release
      from public.olx_scan_jobs j
     where j.created_at >= window_start or j.started_at >= window_start
     order by greatest(j.created_at, coalesce(j.started_at, j.created_at)) asc
     offset (total_count - p_shared_limit)
     limit 1;
  end if;

  next_allowed := greatest(
    coalesce(last_job.created_at + make_interval(mins => interval_minutes), checked_at),
    case when automatic_count >= automatic_limit then oldest_automatic + window_length else checked_at end,
    coalesce(shared_release, checked_at)
  );

  if not filter_row.is_active then
    reason := 'FILTER_INACTIVE';
  elsif not (coalesce(filter_row.sources, '[]'::jsonb) ? 'olx') then
    reason := 'OLX_NOT_SELECTED';
  elsif in_flight > 0 then
    reason := 'OLX_JOB_IN_FLIGHT';
  elsif last_job.created_at is not null and checked_at < last_job.created_at + make_interval(mins => interval_minutes) then
    reason := 'OLX_INTERVAL_NOT_ELAPSED';
  elsif automatic_count >= automatic_limit then
    reason := 'AUTOMATIC_DAILY_BUDGET_USED';
  elsif total_count >= p_shared_limit then
    reason := 'SHARED_DAILY_BUDGET_USED';
  elsif exists (
    -- Fairness for one shared budget: another active OLX filter that is due
    -- and has waited longer (older last OLX order, or none) goes first.
    select 1
      from public.search_filters f
      left join lateral (
        select max(j.created_at) as last_at from public.olx_scan_jobs j
         where j.context_type = 'finder' and j.search_filter_id = f.id
      ) other_last on true
     where f.id <> p_filter_id
       and f.is_active
       and coalesce(f.sources, '[]'::jsonb) ? 'olx'
       and coalesce(other_last.last_at, '-infinity'::timestamptz) < coalesce(last_job.created_at, '-infinity'::timestamptz)
       and (other_last.last_at is null or other_last.last_at + make_interval(mins => f.finder_olx_scan_interval_minutes) <= checked_at)
       and not exists (select 1 from public.olx_scan_jobs j where j.context_type = 'finder' and j.search_filter_id = f.id and j.status in ('queued', 'running'))
       and not exists (select 1 from public.source_scans s where s.search_filter_id = f.id and s.source = 'olx' and s.status in ('pending', 'running'))
  ) then
    reason := 'ANOTHER_FILTER_FIRST';
  end if;

  if reason is null and not p_dry_run then
    if p_request_url is null or p_request_url !~ '^https://(www\.)?olx\.pl/' then
      raise exception 'invalid OLX request url';
    end if;
    if p_filter_snapshot is null or jsonb_typeof(p_filter_snapshot) <> 'object' then
      raise exception 'invalid filter snapshot';
    end if;
    insert into public.source_scans (search_filter_id, source, status, scan_run_id, filter_snapshot)
    values (p_filter_id, 'olx', 'pending', p_run_id, p_filter_snapshot)
    returning id into new_scan_id;
    insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, filter_snapshot, idempotency_key, requested_by)
    values (p_run_id, new_scan_id, p_filter_id, p_request_url, p_filter_snapshot, p_filter_id::text || ':olx:' || p_run_id::text, 'scheduler')
    returning id into new_job_id;
    automatic_count := automatic_count + 1;
    total_count := total_count + 1;
    next_allowed := greatest(checked_at + make_interval(mins => interval_minutes), checked_at + window_length);
  end if;

  return jsonb_build_object(
    'decision', case when reason is not null then 'skipped' when p_dry_run then 'due' else 'enqueued' end,
    'reason', reason,
    'checked_at', checked_at,
    'interval_minutes', interval_minutes,
    'job_id', new_job_id,
    'source_scan_id', new_scan_id,
    'run_id', case when new_job_id is null then null else p_run_id end,
    'last_job_at', last_job.created_at,
    'last_job_status', last_job.status,
    'last_job_automatic', coalesce(last_job.requested_by = 'scheduler', false),
    'next_allowed_at', next_allowed,
    'window_hours', 24,
    'automatic_jobs_in_window', automatic_count,
    'automatic_limit', automatic_limit,
    'finder_other_jobs_in_window', finder_other_count,
    'radar_jobs_in_window', radar_count,
    'cloudflare_jobs_in_window', cloudflare_count,
    'total_jobs_in_window', total_count,
    'shared_limit', p_shared_limit
  );
end;
$$;

commit;
