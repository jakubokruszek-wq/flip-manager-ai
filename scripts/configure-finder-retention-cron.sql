-- Reviewed configuration draft. Do not run as part of a build/deployment.
-- Requires operator approval AND migration 20261013122000 applied first.
--
-- Stage 1 (safe, recommended first): a daily DRY-RUN only. It writes one row
-- to public.finder_retention_runs with what WOULD be removed; nothing is
-- deleted or compacted.
--
-- Stage 2 (only after the operator reviewed the dry-run results): switch the
-- job to real, bounded runs every 15 minutes (at most 10 batches x 500 rows
-- per table per run, SKIP LOCKED, lock_timeout 2s).
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not available; stop without configuring jobs';
  END IF;
  IF to_regprocedure('public.finder_retention_run(boolean,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'finder_retention_run is missing; apply migration 20261013122000 first';
  END IF;
END;
$preflight$;

-- Stage 1: daily dry-run report at 03:17 UTC.
SELECT cron.schedule('finder-retention-dry-run', '17 3 * * *', $job$
  SELECT count(*) FROM public.finder_retention_run(true, 500, 10);
$job$);

COMMIT;

-- Stage 2 (run separately, after approval):
-- SELECT cron.unschedule('finder-retention-dry-run');
-- SELECT cron.schedule('finder-retention', '*/15 * * * *', $job$
--   SELECT count(*) FROM public.finder_retention_run(false, 500, 10);
-- $job$);

-- Read-only checks:
-- SELECT * FROM public.finder_retention_report();
-- SELECT started_at, dry_run, summary, table_bytes_before, table_bytes_after
--   FROM public.finder_retention_runs ORDER BY started_at DESC LIMIT 10;
-- SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
--   FROM pg_stat_user_tables
--  WHERE relname IN ('collector_scan_batches','source_scans','gallery_request_traces','facebook_worker_nonces');
-- Space freed by DELETE/UPDATE is reused by PostgreSQL after (auto)vacuum.
-- Returning it to the operating system needs VACUUM FULL (exclusive lock):
-- never scheduled here, operator approval required.
