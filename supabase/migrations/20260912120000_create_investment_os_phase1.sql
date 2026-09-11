begin;

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  stage text not null default 'DISCOVERED' check (stage in ('DISCOVERED','VERIFYING','VERIFIED','MARKET_READY','UNDERWRITTEN','DECISION_READY','ACQUISITION','RENOVATION','SALE','CLOSED')),
  facts_fingerprint text not null,
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  scout jsonb not null default '{}'::jsonb check (jsonb_typeof(scout) = 'object'),
  verify jsonb not null default '{}'::jsonb check (jsonb_typeof(verify) = 'object'),
  market jsonb not null default '{}'::jsonb check (jsonb_typeof(market) = 'object'),
  underwriting jsonb not null default '{}'::jsonb check (jsonb_typeof(underwriting) = 'object'),
  ceo jsonb not null default '{}'::jsonb check (jsonb_typeof(ceo) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_listing_id_key unique (listing_id)
);

create index if not exists deals_stage_updated_at_idx on public.deals(stage, updated_at desc);

create table if not exists public.deal_fact_overrides (
  deal_id uuid primary key references public.deals(id) on delete cascade,
  values jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.market_assumptions (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  district text,
  building_type text,
  area_min numeric,
  area_max numeric,
  rooms numeric,
  resale_price_per_m2_low numeric not null,
  resale_price_per_m2_base numeric not null,
  resale_price_per_m2_high numeric not null,
  confidence integer not null check (confidence between 0 and 100),
  provenance text not null default 'USER_ASSUMPTION' check (provenance in ('USER_ASSUMPTION','MARKET_ASSUMPTION')),
  effective_from timestamptz not null default now(),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_assumptions_area_range check (area_min is null or area_max is null or area_min <= area_max),
  constraint market_assumptions_prices_positive check (resale_price_per_m2_low > 0 and resale_price_per_m2_base > 0 and resale_price_per_m2_high > 0),
  constraint market_assumptions_prices_ordered check (resale_price_per_m2_low <= resale_price_per_m2_base and resale_price_per_m2_base <= resale_price_per_m2_high)
);

create index if not exists market_assumptions_match_idx on public.market_assumptions(city, district, building_type, rooms, active, effective_from desc);

create table if not exists public.underwriting_settings (
  id text primary key default 'default' check (id = 'default'),
  version integer not null default 1 check (version > 0),
  values jsonb not null check (jsonb_typeof(values) = 'object'),
  updated_at timestamptz not null default now()
);

insert into public.underwriting_settings(id, version, values)
values ('default', 1, '{"renovationPerM2":{"LIGHT":1000,"STANDARD":1800,"FULL":2700},"contingencyPercent":10,"purchaseTaxPercent":2,"fixedPurchaseCosts":3500,"purchaseCommissionPercent":0,"holdingMonths":6,"monthlyHoldingCost":1500,"financingEnabled":false,"financingAnnualRatePercent":9,"financingLoanPercent":70,"salesCostPercent":2,"minimumProfitPLN":50000,"minimumMarginPercent":12,"minimumROI":12,"targetNegotiationBufferPercent":5,"marketResalePerM2":{"low":0,"base":0,"high":0},"marketResaleProvenance":"USER_ASSUMPTION"}'::jsonb)
on conflict (id) do nothing;

create or replace function public.set_investment_os_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
revoke all on function public.set_investment_os_updated_at() from public, anon, authenticated;
grant execute on function public.set_investment_os_updated_at() to service_role;

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at before update on public.deals for each row execute function public.set_investment_os_updated_at();
drop trigger if exists deal_fact_overrides_set_updated_at on public.deal_fact_overrides;
create trigger deal_fact_overrides_set_updated_at before update on public.deal_fact_overrides for each row execute function public.set_investment_os_updated_at();
drop trigger if exists market_assumptions_set_updated_at on public.market_assumptions;
create trigger market_assumptions_set_updated_at before update on public.market_assumptions for each row execute function public.set_investment_os_updated_at();
drop trigger if exists underwriting_settings_set_updated_at on public.underwriting_settings;
create trigger underwriting_settings_set_updated_at before update on public.underwriting_settings for each row execute function public.set_investment_os_updated_at();

alter table public.deals enable row level security;
alter table public.deal_fact_overrides enable row level security;
alter table public.market_assumptions enable row level security;
alter table public.underwriting_settings enable row level security;

revoke all on table public.deals, public.deal_fact_overrides, public.market_assumptions, public.underwriting_settings from anon, authenticated;
grant select, insert, update on table public.deals, public.deal_fact_overrides, public.market_assumptions, public.underwriting_settings to service_role;

commit;
