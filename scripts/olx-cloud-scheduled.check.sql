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
