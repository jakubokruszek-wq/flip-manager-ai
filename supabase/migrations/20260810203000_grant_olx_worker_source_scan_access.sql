begin;

alter table public.source_scans
  add column if not exists scan_run_id uuid;

create index if not exists source_scans_scan_run_idx
  on public.source_scans (scan_run_id, started_at desc);

-- The OLX worker uses the server-only Supabase secret client to create and
-- finalize source scans. Secret API keys still require table privileges even
-- though the service_role bypasses RLS.
grant select, insert, update on table public.source_scans to service_role;

commit;
