begin;

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('otodom', 'olx', 'facebook')),
  external_listing_id text not null,
  original_url text not null,
  normalized_url text,
  title text,
  price numeric,
  area numeric,
  price_per_sqm numeric,
  rooms numeric,
  floor text,
  building_type text,
  ownership text,
  rent numeric,
  address text,
  district text,
  city text,
  description text,
  images jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'removed', 'sold', 'watched')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz,
  content_hash text,
  flip_score numeric,
  estimated_renovation_cost numeric,
  estimated_sale_price numeric,
  estimated_profit numeric,
  estimated_roi numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listings_source_external_listing_id_key unique (source, external_listing_id),
  constraint listings_price_nonnegative check (price is null or price >= 0),
  constraint listings_area_positive check (area is null or area > 0),
  constraint listings_price_per_sqm_nonnegative check (price_per_sqm is null or price_per_sqm >= 0),
  constraint listings_rooms_nonnegative check (rooms is null or rooms >= 0),
  constraint listings_rent_nonnegative check (rent is null or rent >= 0),
  constraint listings_estimated_renovation_cost_nonnegative check (
    estimated_renovation_cost is null or estimated_renovation_cost >= 0
  ),
  constraint listings_estimated_sale_price_nonnegative check (
    estimated_sale_price is null or estimated_sale_price >= 0
  ),
  constraint listings_estimated_roi_nonnegative check (estimated_roi is null or estimated_roi >= 0)
);

create unique index if not exists listings_normalized_url_key
  on public.listings (normalized_url)
  where normalized_url is not null;

create index if not exists listings_content_hash_idx
  on public.listings (content_hash)
  where content_hash is not null;

create index if not exists listings_status_last_seen_at_idx
  on public.listings (status, last_seen_at desc);

create index if not exists listings_city_district_idx
  on public.listings (city, district);

create table if not exists public.listing_snapshots (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  captured_at timestamptz not null default now(),
  price numeric,
  title text,
  description text,
  images jsonb not null default '[]'::jsonb,
  status text not null check (status in ('active', 'removed', 'sold', 'watched')),
  raw_data jsonb not null default '{}'::jsonb,
  constraint listing_snapshots_price_nonnegative check (price is null or price >= 0)
);

create index if not exists listing_snapshots_listing_id_captured_at_idx
  on public.listing_snapshots (listing_id, captured_at desc);

create table if not exists public.search_filters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sources jsonb not null default '[]'::jsonb,
  city text,
  districts jsonb not null default '[]'::jsonb,
  price_min numeric,
  price_max numeric,
  area_min numeric,
  area_max numeric,
  rooms jsonb not null default '[]'::jsonb,
  floor_min numeric,
  floor_max numeric,
  exclude_ground_floor boolean not null default false,
  exclude_top_floor boolean not null default false,
  building_types jsonb not null default '[]'::jsonb,
  ownership_types jsonb not null default '[]'::jsonb,
  market_type text check (market_type in ('primary', 'secondary')),
  private_only boolean not null default false,
  max_price_per_sqm numeric,
  required_keywords jsonb not null default '[]'::jsonb,
  excluded_keywords jsonb not null default '[]'::jsonb,
  min_flip_score numeric,
  min_estimated_profit numeric,
  max_estimated_renovation_cost numeric,
  scan_interval_minutes integer not null default 60,
  is_active boolean not null default true,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint search_filters_sources_array check (jsonb_typeof(sources) = 'array'),
  constraint search_filters_districts_array check (jsonb_typeof(districts) = 'array'),
  constraint search_filters_rooms_array check (jsonb_typeof(rooms) = 'array'),
  constraint search_filters_building_types_array check (jsonb_typeof(building_types) = 'array'),
  constraint search_filters_ownership_types_array check (jsonb_typeof(ownership_types) = 'array'),
  constraint search_filters_required_keywords_array check (jsonb_typeof(required_keywords) = 'array'),
  constraint search_filters_excluded_keywords_array check (jsonb_typeof(excluded_keywords) = 'array'),
  constraint search_filters_price_range check (price_min is null or price_max is null or price_min <= price_max),
  constraint search_filters_area_range check (area_min is null or area_max is null or area_min <= area_max),
  constraint search_filters_floor_range check (floor_min is null or floor_max is null or floor_min <= floor_max),
  constraint search_filters_price_min_nonnegative check (price_min is null or price_min >= 0),
  constraint search_filters_price_max_nonnegative check (price_max is null or price_max >= 0),
  constraint search_filters_area_min_nonnegative check (area_min is null or area_min >= 0),
  constraint search_filters_area_max_nonnegative check (area_max is null or area_max >= 0),
  constraint search_filters_max_price_per_sqm_nonnegative check (
    max_price_per_sqm is null or max_price_per_sqm >= 0
  ),
  constraint search_filters_min_estimated_profit_nonnegative check (
    min_estimated_profit is null or min_estimated_profit >= 0
  ),
  constraint search_filters_max_estimated_renovation_cost_nonnegative check (
    max_estimated_renovation_cost is null or max_estimated_renovation_cost >= 0
  ),
  constraint search_filters_scan_interval_positive check (scan_interval_minutes > 0)
);

create index if not exists search_filters_active_last_scanned_at_idx
  on public.search_filters (is_active, last_scanned_at);

create table if not exists public.source_scans (
  id uuid primary key default gen_random_uuid(),
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  source text not null check (source in ('otodom', 'olx', 'facebook')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'partial')),
  listings_found integer not null default 0 check (listings_found >= 0),
  listings_created integer not null default 0 check (listings_created >= 0),
  listings_updated integer not null default 0 check (listings_updated >= 0),
  error_message text,
  filter_snapshot jsonb not null default '{}'::jsonb,
  constraint source_scans_filter_snapshot_object check (jsonb_typeof(filter_snapshot) = 'object'),
  constraint source_scans_finished_after_started check (
    finished_at is null or finished_at >= started_at
  )
);

create index if not exists source_scans_source_started_at_idx
  on public.source_scans (source, started_at desc);

create index if not exists source_scans_search_filter_id_started_at_idx
  on public.source_scans (search_filter_id, started_at desc);

create table if not exists public.listing_filter_matches (
  listing_id uuid not null references public.listings(id) on delete cascade,
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  first_matched_at timestamptz not null default now(),
  last_matched_at timestamptz not null default now(),
  match_score numeric,
  match_reasons jsonb not null default '[]'::jsonb,
  is_current_match boolean not null default true,
  primary key (listing_id, search_filter_id),
  constraint listing_filter_matches_reasons_array check (jsonb_typeof(match_reasons) = 'array')
);

create index if not exists listing_filter_matches_filter_current_last_matched_idx
  on public.listing_filter_matches (search_filter_id, is_current_match, last_matched_at desc);

alter table public.properties
  add column if not exists listing_id uuid references public.listings(id) on delete set null;

create index if not exists properties_listing_id_idx
  on public.properties (listing_id)
  where listing_id is not null;

create or replace function public.set_listing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists listings_set_updated_at on public.listings;

create trigger listings_set_updated_at
before update on public.listings
for each row
execute function public.set_listing_updated_at();

create or replace function public.set_search_filter_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists search_filters_set_updated_at on public.search_filters;

create trigger search_filters_set_updated_at
before update on public.search_filters
for each row
execute function public.set_search_filter_updated_at();

alter table public.listings enable row level security;
alter table public.listing_snapshots enable row level security;
alter table public.search_filters enable row level security;
alter table public.source_scans enable row level security;
alter table public.listing_filter_matches enable row level security;

-- WYŁĄCZNIE PRYWATNA WERSJA DEVELOPERSKA.
-- Aplikacja działa bez logowania, więc anon ma pełny dostęp do tych tabel.
-- Przed publicznym wdrożeniem należy dodać Auth, user_id i polityki ograniczające dostęp do rekordów użytkownika.
grant select, insert, update, delete on table public.listings to anon;
grant select, insert, update, delete on table public.listing_snapshots to anon;
grant select, insert, update, delete on table public.search_filters to anon;
grant select, insert, update, delete on table public.source_scans to anon;
grant select, insert, update, delete on table public.listing_filter_matches to anon;

drop policy if exists "listings_select_development" on public.listings;
drop policy if exists "listings_insert_development" on public.listings;
drop policy if exists "listings_update_development" on public.listings;
drop policy if exists "listings_delete_development" on public.listings;

create policy "listings_select_development"
  on public.listings for select to anon using (true);
create policy "listings_insert_development"
  on public.listings for insert to anon with check (true);
create policy "listings_update_development"
  on public.listings for update to anon using (true) with check (true);
create policy "listings_delete_development"
  on public.listings for delete to anon using (true);

drop policy if exists "listing_snapshots_select_development" on public.listing_snapshots;
drop policy if exists "listing_snapshots_insert_development" on public.listing_snapshots;
drop policy if exists "listing_snapshots_update_development" on public.listing_snapshots;
drop policy if exists "listing_snapshots_delete_development" on public.listing_snapshots;

create policy "listing_snapshots_select_development"
  on public.listing_snapshots for select to anon using (true);
create policy "listing_snapshots_insert_development"
  on public.listing_snapshots for insert to anon with check (true);
create policy "listing_snapshots_update_development"
  on public.listing_snapshots for update to anon using (true) with check (true);
create policy "listing_snapshots_delete_development"
  on public.listing_snapshots for delete to anon using (true);

drop policy if exists "search_filters_select_development" on public.search_filters;
drop policy if exists "search_filters_insert_development" on public.search_filters;
drop policy if exists "search_filters_update_development" on public.search_filters;
drop policy if exists "search_filters_delete_development" on public.search_filters;

create policy "search_filters_select_development"
  on public.search_filters for select to anon using (true);
create policy "search_filters_insert_development"
  on public.search_filters for insert to anon with check (true);
create policy "search_filters_update_development"
  on public.search_filters for update to anon using (true) with check (true);
create policy "search_filters_delete_development"
  on public.search_filters for delete to anon using (true);

drop policy if exists "source_scans_select_development" on public.source_scans;
drop policy if exists "source_scans_insert_development" on public.source_scans;
drop policy if exists "source_scans_update_development" on public.source_scans;
drop policy if exists "source_scans_delete_development" on public.source_scans;

create policy "source_scans_select_development"
  on public.source_scans for select to anon using (true);
create policy "source_scans_insert_development"
  on public.source_scans for insert to anon with check (true);
create policy "source_scans_update_development"
  on public.source_scans for update to anon using (true) with check (true);
create policy "source_scans_delete_development"
  on public.source_scans for delete to anon using (true);

drop policy if exists "listing_filter_matches_select_development" on public.listing_filter_matches;
drop policy if exists "listing_filter_matches_insert_development" on public.listing_filter_matches;
drop policy if exists "listing_filter_matches_update_development" on public.listing_filter_matches;
drop policy if exists "listing_filter_matches_delete_development" on public.listing_filter_matches;

create policy "listing_filter_matches_select_development"
  on public.listing_filter_matches for select to anon using (true);
create policy "listing_filter_matches_insert_development"
  on public.listing_filter_matches for insert to anon with check (true);
create policy "listing_filter_matches_update_development"
  on public.listing_filter_matches for update to anon using (true) with check (true);
create policy "listing_filter_matches_delete_development"
  on public.listing_filter_matches for delete to anon using (true);

commit;
