create table public.collector_mobile_scan_reports (
  device_id uuid not null references public.collector_devices(id) on delete cascade,
  batch_id uuid not null,
  scan_id uuid not null,
  source_id text not null,
  app_version text not null,
  report jsonb not null check (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 65536),
  received_at timestamptz not null default now(),
  primary key (device_id, batch_id)
);
create index collector_mobile_scan_reports_source_time on public.collector_mobile_scan_reports(source_id, received_at desc);
alter table public.collector_mobile_scan_reports enable row level security;
revoke all on public.collector_mobile_scan_reports from public, anon, authenticated;
grant select, insert, update, delete on public.collector_mobile_scan_reports to service_role;
comment on table public.collector_mobile_scan_reports is 'Private bounded mobile capture counters and exact post IDs. No post text, photos or credentials.';
