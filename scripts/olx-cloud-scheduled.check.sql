-- READ-ONLY monitoring of unattended OLX (docs/olx-cloud-scheduled.md §8).
-- Safe at any time in the Supabase SQL Editor: SELECTs only, no secrets.

-- 1. Database switch (STOP = false).
select scheduled_claim_enabled, max_claims_24h, unclaimed_expiry_minutes, note, updated_at
  from public.olx_automation_control;

-- 2. Last automatic Finder OLX jobs: ordered -> claimed -> finished, by whom, with which code.
select j.id, f.name as filter, j.status, j.attempts, j.worker_id, j.error_code,
       j.created_at, j.started_at, j.finished_at,
       j.finished_at - j.started_at as run_time,
       j.started_at - j.created_at as waited_for_claim,
       (j.result_summary->>'fetched')::int as fetched
  from public.olx_scan_jobs j left join public.search_filters f on f.id = j.search_filter_id
 where j.context_type = 'finder' and j.requested_by = 'scheduler'
 order by j.created_at desc
 limit 10;

-- 3. Shared OLX budget of the last 24 h (all consumers, all workers).
select context_type, coalesce(requested_by, 'manual/radar') as origin, status, count(*),
       count(*) filter (where worker_id like 'cloudflare%') as by_cloudflare
  from public.olx_scan_jobs
 where created_at > now() - interval '24 hours' or started_at > now() - interval '24 hours'
 group by 1, 2, 3 order by 1, 2, 3;

-- 4. Parallel work or orphans right now (expected: 0 rows each).
select id, context_type, worker_id, leased_until from public.olx_scan_jobs
 where status = 'running' and leased_until > now();
select id, context_type, status, created_at, leased_until from public.olx_scan_jobs
 where (status = 'queued' and created_at < now() - interval '6 hours')
    or (status = 'running' and leased_until < now() - interval '10 minutes');

-- 5. Diagnosed failures of the automation (history is kept, never deleted).
select error_code, count(*), max(finished_at) as last
  from public.olx_scan_jobs
 where requested_by = 'scheduler' and status = 'failed'
 group by 1 order by 3 desc;

-- ---- Slot schedule (migration 20261016120000) ----

-- 6. Schedule per filter: start time, interval, durable anchor, current/next slot (Warsaw).
select f.name, to_char(f.finder_olx_start_time, 'HH24:MI') as start_time, f.finder_olx_scan_interval_minutes / 60 as interval_h,
       f.finder_olx_schedule_anchor as anchor_local, w.current_slot, w.next_slot
  from public.search_filters f
  cross join lateral public.finder_olx_slot_window(f.finder_olx_schedule_anchor, f.finder_olx_scan_interval_minutes, now()) w
 where f.is_active and f.sources ? 'olx'
 order by f.name;

-- 7. Last slots: planned vs actual start (delay), job result; missed slots with their cause.
select f.name, s.slot_at as planned, s.status as slot, s.reason, j.started_at as actual_start,
       j.started_at - s.slot_at as delay, j.status as job, j.error_code, j.worker_id
  from public.finder_olx_slots s
  join public.search_filters f on f.id = s.search_filter_id
  left join public.olx_scan_jobs j on j.id = s.job_id
 order by s.slot_at desc
 limit 20;

-- 8. Browser Run budget reported by the scheduled Worker (today, UTC).
select * from public.olx_cloud_budget_today(now());

-- 9. Radar: no OLX job may be queued or running (expected: 0 rows); retired ones are audited.
select id, status, error_code, result_summary->'radarOlxRemoved' as audit
  from public.olx_scan_jobs where context_type = 'price_radar' and status in ('queued', 'running');
select status, error_code, count(*) from public.olx_scan_jobs where context_type = 'price_radar' group by 1, 2 order by 1, 2;
