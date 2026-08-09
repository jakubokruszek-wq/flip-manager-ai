begin;

create table if not exists public.alerts (
  id text primary key,
  event_key text not null unique,
  type text not null check (type in ('facebook_opportunity','high_flip_score','price_drop','private_seller','new_listing')),
  listing_id uuid not null references public.listings(id) on delete cascade,
  title text not null,
  source text not null,
  seller_type text,
  price numeric,
  neighborhood text,
  city text,
  price_per_sqm numeric,
  flip_score numeric,
  opportunity_score numeric,
  detected_at timestamptz not null,
  read_at timestamptz,
  details_url text not null,
  original_url text,
  created_at timestamptz not null default now()
);

create index if not exists alerts_read_detected_idx on public.alerts (read_at, detected_at desc);
create index if not exists alerts_listing_idx on public.alerts (listing_id, detected_at desc);

create table if not exists public.alert_preferences (
  id text primary key default 'default',
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint alert_preferences_settings_object check (jsonb_typeof(settings) = 'object')
);

alter table public.alerts enable row level security;
alter table public.alert_preferences enable row level security;
revoke all on table public.alerts from anon, authenticated;
revoke all on table public.alert_preferences from anon, authenticated;
grant select, insert, update on table public.alerts to service_role;
grant select, insert, update on table public.alert_preferences to service_role;
grant select on table public.listing_snapshots to service_role;

commit;
