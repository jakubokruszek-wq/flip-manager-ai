-- READ-ONLY check of the two Finder pg_cron jobs, before and after
-- scripts/finder-cron-every-5-minutes.sql. Safe to run at any time in the
-- Supabase SQL Editor: only SELECTs, no command text, URL or secret is shown
-- (commands are compared by md5).

-- 1. Exactly one job per name; today expected: '* * * * *', after: '*/5 * * * *'.
SELECT jobid, jobname, schedule, active, md5(command) AS command_md5, database, username
  FROM cron.job
 WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation')
 ORDER BY jobname;

-- 2. All other cron jobs (must be identical before and after the change).
SELECT jobid, jobname, schedule, active, md5(command) AS command_md5
  FROM cron.job
 WHERE jobname NOT IN ('finder-scan-scheduler', 'finder-scan-continuation')
 ORDER BY jobid;

-- 3. Recent deliveries. 'succeeded' only means the HTTP request was sent
--    (the route answers 202 before the cycle runs); outcomes are in Vercel
--    logs (FINDER_SCHEDULER_*, FINDER_OLX_SCHEDULER_DECISION).
SELECT j.jobname, d.status, d.start_time, d.end_time, left(d.return_message, 120) AS return_message
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname IN ('finder-scan-scheduler', 'finder-scan-continuation')
 ORDER BY d.start_time DESC
 LIMIT 12;

-- 4. Calls in the last 24 h per job: ~1440 every minute, ~288 every 5 minutes.
SELECT j.jobname, count(*) AS runs_24h,
       count(*) FILTER (WHERE d.status <> 'succeeded') AS not_succeeded_24h,
       max(d.start_time) AS last_run
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname IN ('finder-scan-scheduler', 'finder-scan-continuation')
   AND d.start_time > now() - interval '24 hours'
 GROUP BY j.jobname
 ORDER BY j.jobname;

-- 5. Spacing between the last runs of the scheduler (after the change: 5 min).
SELECT d.start_time, d.start_time - lag(d.start_time) OVER (ORDER BY d.start_time) AS since_previous
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname = 'finder-scan-scheduler'
 ORDER BY d.start_time DESC
 LIMIT 6;
