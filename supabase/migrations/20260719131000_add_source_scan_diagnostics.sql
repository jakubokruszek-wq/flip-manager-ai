begin;

alter table public.source_scans
  add column if not exists scan_run_id uuid,
  add column if not exists diagnostics jsonb not null default '[]'::jsonb;

alter table public.source_scans
  drop constraint if exists source_scans_diagnostics_array;

alter table public.source_scans
  add constraint source_scans_diagnostics_array
  check (jsonb_typeof(diagnostics) = 'array');

create index if not exists source_scans_scan_run_id_started_at_idx
  on public.source_scans (scan_run_id, started_at asc)
  where scan_run_id is not null;

commit;
