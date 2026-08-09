begin;

-- Private development MVP: API routes authenticate the device token. Before a public
-- release, replace these anon policies with Supabase Auth and per-user ownership.
alter table public.listing_filter_matches
  add column if not exists match_origin text not null default 'scan';

alter table public.listing_filter_matches
  drop constraint if exists listing_filter_matches_match_origin_check;

alter table public.listing_filter_matches
  add constraint listing_filter_matches_match_origin_check
  check (match_origin in ('scan', 'filter_recalculation', 'collector_import'));

create table if not exists public.collector_devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  installation_id text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.collector_imports (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.collector_devices(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete set null,
  idempotency_key text not null,
  source_post_url text not null,
  payload jsonb not null,
  status text not null default 'received'
    check (status in ('received', 'imported', 'pending_review', 'failed')),
  error_message text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint collector_imports_device_idempotency_key_key unique (device_id, idempotency_key),
  constraint collector_imports_payload_object check (jsonb_typeof(payload) = 'object')
  ,constraint collector_imports_result_object check (jsonb_typeof(result) = 'object')
);

create index if not exists collector_imports_device_created_at_idx
  on public.collector_imports (device_id, created_at desc);

create table if not exists public.listing_source_metadata (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  source text not null check (source in ('facebook')),
  source_post_url text not null,
  group_name text,
  author_name text,
  published_at timestamptz,
  collected_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  constraint listing_source_metadata_source_post_url_key unique (source, source_post_url),
  constraint listing_source_metadata_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists listing_source_metadata_source_collected_at_idx
  on public.listing_source_metadata (source, collected_at desc);

create index if not exists listing_source_metadata_listing_id_idx
  on public.listing_source_metadata (listing_id);

alter table public.collector_devices enable row level security;
alter table public.collector_imports enable row level security;
alter table public.listing_source_metadata enable row level security;

revoke all on table public.collector_devices from anon;
revoke all on table public.collector_imports from anon;
revoke all on table public.listing_source_metadata from anon;

drop policy if exists "collector_devices_development" on public.collector_devices;
drop policy if exists "collector_imports_development" on public.collector_imports;
drop policy if exists "listing_source_metadata_development" on public.listing_source_metadata;

comment on table public.collector_devices is
  'No anon access. Collector operations are available only through Next.js endpoints using the service-role key.';

commit;
