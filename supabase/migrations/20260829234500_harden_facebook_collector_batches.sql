begin;

create table if not exists public.collector_request_nonces (
  device_id uuid not null references public.collector_devices(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (device_id, nonce)
);

create index if not exists collector_request_nonces_expires_at_idx
  on public.collector_request_nonces (expires_at);

create table if not exists public.collector_scan_batches (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.collector_devices(id) on delete cascade,
  scan_id uuid not null,
  batch_id uuid not null,
  source_id text not null,
  source_type text not null check (source_type in ('GROUP', 'PROFILE')),
  source_url text not null,
  status text not null default 'received'
    check (status in ('received', 'processing', 'completed', 'degraded', 'failed')),
  health_status text not null
    check (health_status in ('HEALTHY', 'DEGRADED', 'FAILED')),
  visible_card_count integer not null default 0 check (visible_card_count >= 0),
  captured_post_count integer not null default 0 check (captured_post_count >= 0),
  capture_ratio numeric not null default 0 check (capture_ratio >= 0 and capture_ratio <= 1),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  received_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint collector_scan_batches_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint collector_scan_batches_result_object check (jsonb_typeof(result) = 'object'),
  constraint collector_scan_batches_device_batch_unique unique (device_id, batch_id)
);

create index if not exists collector_scan_batches_device_received_idx
  on public.collector_scan_batches (device_id, received_at desc);

create index if not exists collector_scan_batches_scan_source_idx
  on public.collector_scan_batches (scan_id, source_id);

alter table public.collector_devices
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists last_source_scan_at timestamptz,
  add column if not exists last_captured_count integer not null default 0 check (last_captured_count >= 0),
  add column if not exists health_status text not null default 'FAILED'
    check (health_status in ('HEALTHY', 'DEGRADED', 'FAILED'));

alter table public.collector_request_nonces enable row level security;
alter table public.collector_scan_batches enable row level security;

revoke all on table public.collector_request_nonces from anon, authenticated;
revoke all on table public.collector_scan_batches from anon, authenticated;
grant select, insert, update, delete on table public.collector_request_nonces to service_role;
grant select, insert, update on table public.collector_scan_batches to service_role;

comment on table public.collector_scan_batches is
  'Signed, idempotent Facebook Collector source batches. DEGRADED coverage never becomes completed.';

commit;
