begin;

-- Resale comparables are deliberately kept separate from flip-candidate
-- listings.  A comparable may inform ARV without becoming an opportunity.
create table if not exists public.resale_comps (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('facebook', 'otodom', 'olx', 'morizon')),
  external_listing_id text not null,
  canonical_url text,
  title text,
  description text,
  city text,
  district text,
  street text,
  address text,
  latitude numeric,
  longitude numeric,
  price numeric,
  area_m2 numeric,
  price_per_m2 numeric,
  rooms numeric,
  floor text,
  floors text,
  building_type text,
  construction_year integer,
  ownership text,
  balcony boolean,
  elevator boolean,
  parking boolean,
  renovation_status text not null default 'UNKNOWN',
  renovation_confidence text not null default 'LOW',
  finish_level text,
  listing_created_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  active boolean not null default true,
  seller_type text,
  fingerprint text,
  outlier_reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resale_comps_price_nonnegative check (price is null or price >= 0),
  constraint resale_comps_area_positive check (area_m2 is null or area_m2 > 0),
  constraint resale_comps_price_per_m2_nonnegative check (price_per_m2 is null or price_per_m2 >= 0),
  constraint resale_comps_renovation_status_check check (renovation_status in ('RENOVATED', 'MOVE_IN_READY', 'REFRESHED', 'UNKNOWN')),
  constraint resale_comps_renovation_confidence_check check (renovation_confidence in ('HIGH', 'MEDIUM', 'LOW'))
);

create unique index if not exists resale_comps_source_external_id_key
  on public.resale_comps (source, external_listing_id);
create unique index if not exists resale_comps_canonical_url_key
  on public.resale_comps (canonical_url)
  where canonical_url is not null;
create unique index if not exists resale_comps_fingerprint_key
  on public.resale_comps (fingerprint)
  where fingerprint is not null;
create index if not exists resale_comps_location_last_seen_idx
  on public.resale_comps (city, district, street, last_seen_at desc);
create index if not exists resale_comps_confidence_active_idx
  on public.resale_comps (renovation_confidence, active, last_seen_at desc);

create table if not exists public.resale_comp_price_history (
  id uuid primary key default gen_random_uuid(),
  comp_id uuid not null references public.resale_comps(id) on delete cascade,
  observed_at timestamptz not null default now(),
  price numeric,
  price_per_m2 numeric,
  constraint resale_comp_price_history_price_nonnegative check (price is null or price >= 0),
  constraint resale_comp_price_history_price_per_m2_nonnegative check (price_per_m2 is null or price_per_m2 >= 0)
);

create index if not exists resale_comp_price_history_comp_observed_idx
  on public.resale_comp_price_history (comp_id, observed_at desc);

alter table public.resale_comps enable row level security;
alter table public.resale_comp_price_history enable row level security;

grant select on table public.resale_comps to anon, authenticated;
grant all on table public.resale_comps to service_role;
grant select on table public.resale_comp_price_history to anon, authenticated;
grant all on table public.resale_comp_price_history to service_role;

drop policy if exists "resale_comps_select_app" on public.resale_comps;
create policy "resale_comps_select_app"
  on public.resale_comps for select to anon, authenticated using (true);
drop policy if exists "resale_comp_price_history_select_app" on public.resale_comp_price_history;
create policy "resale_comp_price_history_select_app"
  on public.resale_comp_price_history for select to anon, authenticated using (true);

commit;
