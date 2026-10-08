begin;

-- DRAFT — authored for review only. Not applied to any database as part of
-- this change (no `supabase db push` / migration run was performed). Creates
-- the Price Radar module's own tables, fully isolated from Finder/Watcher:
-- a separate canonical table (price_radar_listings, never public.listings),
-- a separate run/checkpoint table, and its own RLS policies. No existing
-- table, column, policy, or grant is touched.

create table if not exists public.price_radar_listings (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka','nieruchomosci_online','oferty_net','szybko','domy','allegro_lokalnie','official_cooperative','official_uml')),
  external_listing_id text not null,
  original_url text not null,
  normalized_url text not null,
  title text,
  description text,
  price numeric not null check (price > 0),
  area numeric not null check (area > 0),
  price_per_sqm numeric not null check (price_per_sqm > 0),
  rooms integer,
  city text not null,
  district text not null,
  -- Qualification is intentionally restrictive at the schema level too:
  -- only confirmed blok/apartamentowiec, only a confirmed, specific
  -- renovation state per market. Never "unknown" -- an unqualified listing
  -- is simply never inserted here at all (see qualification.ts).
  building_type text not null check (building_type in ('blok', 'apartamentowiec')),
  market_type text not null check (market_type in ('primary', 'secondary')),
  renovation_status text not null check (renovation_status in ('fresh_renovation', 'turnkey_finish')),
  content_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- Exclusion is Radar-only bookkeeping on its own row; it never touches
  -- public.listings, canonical reconciliation, or any Finder/Watcher state.
  excluded_at timestamptz,
  excluded_reason text,
  raw_payload jsonb not null default '{}'::jsonb,
  constraint price_radar_listings_source_external_key unique (source, external_listing_id)
);

create index if not exists price_radar_listings_district_market_idx
  on public.price_radar_listings (district, market_type)
  where status = 'active' and excluded_at is null;

create index if not exists price_radar_listings_normalized_url_idx
  on public.price_radar_listings (source, normalized_url);

alter table public.price_radar_listings enable row level security;
grant select on table public.price_radar_listings to authenticated;
grant all on table public.price_radar_listings to service_role;

drop policy if exists "price_radar_listings_select_authenticated" on public.price_radar_listings;
create policy "price_radar_listings_select_authenticated"
  on public.price_radar_listings for select to authenticated using (true);

create table if not exists public.price_radar_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'partial')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- { sourceQueue: string[], currentSourceIndex: number, perSourceCursor:
  -- Record<string, unknown>, buffer: unknown[], offset: number } -- see
  -- collect.ts's own RadarCheckpoint type for the authoritative shape.
  checkpoint jsonb not null default '{}'::jsonb,
  lease_token text,
  lease_until timestamptz,
  scanned_count integer not null default 0,
  qualified_count integer not null default 0,
  error_message text
);

-- Exactly one run may be pending/running at a time -- the partial unique
-- index indexes the same constant for every qualifying row, so a second
-- concurrent run row violates uniqueness and is rejected at the database
-- level, not just by an application-side check.
create unique index if not exists price_radar_runs_one_active_idx
  on public.price_radar_runs ((true))
  where status in ('pending', 'running');

alter table public.price_radar_runs enable row level security;
grant select on table public.price_radar_runs to authenticated;
grant all on table public.price_radar_runs to service_role;

drop policy if exists "price_radar_runs_select_authenticated" on public.price_radar_runs;
create policy "price_radar_runs_select_authenticated"
  on public.price_radar_runs for select to authenticated using (true);

commit;
