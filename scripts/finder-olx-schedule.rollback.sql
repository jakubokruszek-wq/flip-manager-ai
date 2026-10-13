-- Rollback of supabase/migrations/20261014120000_add_finder_olx_schedule.sql.
-- Run by hand in the Supabase SQL Editor only after the application code that
-- calls enqueue_scheduled_finder_olx_job has been reverted (otherwise the
-- scheduler keeps working but never queues an automatic OLX job: it reports
-- OLX_SCHEDULE_UNAVAILABLE and the other portals are unaffected).
--
-- Removes only what the migration added. Existing OLX jobs, source scans and
-- filters are kept; the per-filter OLX interval and the requested_by marker
-- are dropped (they hold no other data).
begin;

drop function if exists public.enqueue_scheduled_finder_olx_job(uuid, uuid, text, jsonb, integer, boolean);
drop index if exists public.olx_scan_jobs_filter_created_idx;
drop index if exists public.olx_scan_jobs_created_at_idx;
alter table public.olx_scan_jobs drop constraint if exists olx_scan_jobs_requested_by_check;
alter table public.olx_scan_jobs drop column if exists requested_by;
alter table public.search_filters drop constraint if exists search_filters_finder_olx_scan_interval_min;
alter table public.search_filters drop column if exists finder_olx_scan_interval_minutes;

commit;
