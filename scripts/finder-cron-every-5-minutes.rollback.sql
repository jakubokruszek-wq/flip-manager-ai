-- Rollback of scripts/finder-cron-every-5-minutes.sql: restores the previous
-- every-minute schedule of the two Finder pg_cron jobs. Commands, secrets and
-- every other cron job stay unchanged. Run by hand only after approval.
BEGIN;

DO $preflight$
DECLARE
  job_name text;
BEGIN
  FOREACH job_name IN ARRAY ARRAY['finder-scan-scheduler', 'finder-scan-continuation'] LOOP
    IF (SELECT count(*) FROM cron.job WHERE jobname = job_name) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one cron job named %; nothing changed', job_name;
    END IF;
  END LOOP;
END;
$preflight$;

SELECT cron.alter_job(jobid, schedule := '* * * * *')
  FROM cron.job
 WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation');

COMMIT;
