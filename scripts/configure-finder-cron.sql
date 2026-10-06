-- Reviewed configuration draft. Do not run as part of a build/deployment.
-- First create Vault secret "finder_cron_secret" through the Supabase UI,
-- with the same value as Vercel's FINDER_CRON_SECRET. Never paste it here.
-- Existing Facebook/OLX jobs are not changed.
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not available; stop without configuring jobs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net is not available; stop without configuring jobs';
  END IF;
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'Vault is not available; stop without configuring jobs';
  END IF;
  IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name = 'finder_cron_secret' AND length(decrypted_secret) > 0) <> 1 THEN
    RAISE EXCEPTION 'Exactly one nonempty finder_cron_secret is required in Vault';
  END IF;
END;
$preflight$;

SELECT cron.schedule('finder-scan-scheduler', '*/5 * * * *', $job$
  SELECT net.http_post(
    url := 'https://flip-manager-ai.vercel.app/api/jobs/finder-scan-scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'finder_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);

SELECT cron.schedule('finder-scan-continuation', '*/5 * * * *', $job$
  SELECT net.http_post(
    url := 'https://flip-manager-ai.vercel.app/api/jobs/finder-scan-continuation',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'finder_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);

COMMIT;

-- Read-only checks, without secret values or authorization headers:
-- SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net', 'supabase_vault');
-- SELECT name, true AS present FROM vault.secrets WHERE name = 'finder_cron_secret';
-- SELECT jobid, jobname, schedule, active FROM cron.job
-- WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation');
-- SELECT jobid, status, start_time, end_time FROM cron.job_run_details
-- WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname IN ('finder-scan-scheduler', 'finder-scan-continuation'))
-- ORDER BY start_time DESC LIMIT 8;
