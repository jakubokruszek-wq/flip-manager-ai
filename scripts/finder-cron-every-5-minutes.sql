-- Reviewed change draft. Do NOT run as part of a build or deployment; run it
-- once by hand in the Supabase SQL Editor after separate approval.
--
-- Changes ONLY the schedule of the two existing Finder pg_cron jobs from
-- every minute ('* * * * *') to every five minutes ('*/5 * * * *'):
-- 2 x 1440 = 2880 -> 2 x 288 = 576 HTTP calls to Vercel per day.
-- The job commands (URL, Vault-backed Authorization header) are untouched;
-- no secret is read or printed. Facebook, Price Radar and any other cron job
-- are not changed. This is the trigger frequency only: each filter's own
-- cadence stays search_filters.finder_scan_interval_minutes (Flip: 300).
--
-- Rollback: scripts/finder-cron-every-5-minutes.rollback.sql
BEGIN;

DO $preflight$
DECLARE
  job_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not available; nothing changed';
  END IF;
  FOREACH job_name IN ARRAY ARRAY['finder-scan-scheduler', 'finder-scan-continuation'] LOOP
    IF (SELECT count(*) FROM cron.job WHERE jobname = job_name) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one cron job named %; nothing changed', job_name;
    END IF;
  END LOOP;
END;
$preflight$;

SELECT cron.alter_job(jobid, schedule := '*/5 * * * *')
  FROM cron.job
 WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation');

DO $verify$
BEGIN
  IF (SELECT count(*) FROM cron.job
       WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation')
         AND schedule = '*/5 * * * *' AND active) <> 2 THEN
    RAISE EXCEPTION 'Finder cron jobs are not both active every 5 minutes; rolled back';
  END IF;
END;
$verify$;

COMMIT;

-- Read-only checks (no secrets, no authorization headers):
-- SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
-- SELECT j.jobname, d.status, d.start_time, d.end_time
--   FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--  WHERE j.jobname IN ('finder-scan-scheduler', 'finder-scan-continuation')
--  ORDER BY d.start_time DESC LIMIT 10;
