-- Reviewed configuration draft. Do not run as part of a build/deployment.
--
-- Why: Radar continues each run itself after every portion, but if that chain
-- is ever cut (function killed, hand-off rejected, long Retry-After) the run
-- waits with an expired lease until something calls the collect endpoint.
-- GitHub Actions' schedule fired once in a whole day (2026-10-13) and Vercel
-- Hobby cannot run a frequent cron, so Supabase pg_cron is the watchdog that
-- does not depend on an open PWA or a running computer.
--
-- The watchdog tick is the same protected owner tick as the GitHub scheduler:
-- it only resumes an existing run whose lease expired (same run ID, same
-- checkpoint) or starts the saved daily run when it is due. With an active
-- lease it is a no-op. The endpoint acknowledges with 202 at once
-- (x-radar-watchdog: 1) and does the portion after the response.
--
-- First create Vault secret "price_radar_cron_secret" through the Supabase UI,
-- with the same value as Vercel's PRICE_RADAR_CRON_SECRET. Never paste it here.
-- Finder, Facebook and OLX jobs are not changed.
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
  IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name = 'price_radar_cron_secret' AND length(decrypted_secret) > 0) <> 1 THEN
    RAISE EXCEPTION 'Exactly one nonempty price_radar_cron_secret is required in Vault';
  END IF;
END;
$preflight$;

SELECT cron.schedule('price-radar-watchdog', '* * * * *', $job$
  SELECT net.http_post(
    url := 'https://flip-manager-ai.vercel.app/api/jobs/price-radar-collect',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-radar-watchdog', '1', 'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'price_radar_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);

COMMIT;

-- Read-only checks, without secret values or authorization headers:
-- SELECT name, true AS present FROM vault.secrets WHERE name = 'price_radar_cron_secret';
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'price-radar-watchdog';
-- SELECT jobid, status, start_time, end_time FROM cron.job_run_details
-- WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'price-radar-watchdog')
-- ORDER BY start_time DESC LIMIT 8;
--
-- To disable: SELECT cron.unschedule('price-radar-watchdog');
