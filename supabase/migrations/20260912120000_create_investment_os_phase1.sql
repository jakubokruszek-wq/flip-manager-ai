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
  playbook jsonb not null default '{}'::jsonb check (jsonb_typeof(playbook) = 'object'),
  evidence_fabric jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_fabric) = 'array'),
  information_requests jsonb not null default '[]'::jsonb check (jsonb_typeof(information_requests) = 'array'),
  analysis_level integer not null default 1 check (analysis_level between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_listing_id_key unique (listing_id)
);

create index if not exists deals_stage_updated_at_idx on public.deals(stage, updated_at desc);

create table if not exists public.deal_evidence (
  id text primary key,
  deal_id uuid not null references public.deals(id) on delete cascade,
  type text not null check (type in ('FACT','ASSUMPTION','ESTIMATE','PREDICTION','USER_OVERRIDE','UNKNOWN')),
  source_type text not null check (source_type in ('OFFICIAL_PRIMARY','VERIFIED_STRUCTURED_DATA','DIRECT_OBSERVATION','MULTIPLE_INDEPENDENT_SOURCES','REPUTABLE_SECONDARY','USER_PROVIDED','AI_INFERENCE','UNKNOWN')),
  source_name text not null check (char_length(source_name) between 1 and 160),
  structured_payload jsonb not null default 'null'::jsonb,
  source_url text,
  document_id text,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  reliability integer not null check (reliability between 0 and 100),
  confidence integer not null check (confidence between 0 and 100),
  director_who_requested text not null check (director_who_requested in ('SCOUT','VERIFY','MARKET','UNDERWRITER','CEO')),
  verification_status text not null check (verification_status in ('VERIFIED','UNVERIFIED','CONFLICT','STALE')),
  conflicts_with jsonb not null default '[]'::jsonb check (jsonb_typeof(conflicts_with) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deal_evidence_deal_observed_idx on public.deal_evidence(deal_id, observed_at desc);

create table if not exists public.director_runs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  director text not null check (director in ('SCOUT','VERIFY','MARKET','UNDERWRITER','CEO')),
  input_fingerprint text not null,
  output_version integer not null check (output_version > 0),
  status text not null check (status in ('NOT_RUN','READY','RUNNING','COMPLETE','STALE','BLOCKED','FAILED')),
  tools_requested jsonb not null default '[]'::jsonb check (jsonb_typeof(tools_requested) = 'array'),
  tools_succeeded jsonb not null default '[]'::jsonb check (jsonb_typeof(tools_succeeded) = 'array'),
  tools_failed jsonb not null default '[]'::jsonb check (jsonb_typeof(tools_failed) = 'array'),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  output jsonb not null default '{}'::jsonb check (jsonb_typeof(output) = 'object'),
  confidence integer not null check (confidence between 0 and 100),
  elapsed_ms integer not null check (elapsed_ms >= 0),
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint director_runs_idempotency unique (deal_id, director, input_fingerprint, output_version)
);

create index if not exists director_runs_deal_computed_idx on public.director_runs(deal_id, computed_at desc);

create table if not exists public.director_information_requests (
  id text primary key,
  deal_id uuid not null references public.deals(id) on delete cascade,
  field text not null,
  question text not null check (char_length(question) between 1 and 500),
  priority text not null check (priority in ('LOW','MEDIUM','HIGH','CRITICAL')),
  value_of_information integer not null check (value_of_information between 0 and 100),
  decision_impact jsonb not null default '[]'::jsonb check (jsonb_typeof(decision_impact) = 'array'),
  requested_by text not null check (requested_by in ('SCOUT','VERIFY','MARKET','UNDERWRITER','CEO','RISK','LEGAL')),
  evidence_needed text not null check (char_length(evidence_needed) between 1 and 500),
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','DISMISSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists director_information_requests_deal_priority_idx on public.director_information_requests(deal_id, value_of_information desc) where status = 'OPEN';

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

create table if not exists public.deal_outcomes (
  deal_id uuid primary key references public.deals(id) on delete cascade,
  actual_resale_value numeric check (actual_resale_value is null or actual_resale_value >= 0),
  actual_renovation_cost numeric check (actual_renovation_cost is null or actual_renovation_cost >= 0),
  actual_duration_days integer check (actual_duration_days is null or actual_duration_days >= 0),
  actual_profit numeric,
  risk_misses jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_misses) = 'array'),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.director_scorecards (
  director text primary key check (director in ('SCOUT','VERIFY','MARKET','UNDERWRITER','CEO','RISK','LEGAL')),
  deal_count integer not null default 0 check (deal_count >= 0),
  median_error_percent numeric,
  p90_error_percent numeric,
  confidence_calibration text,
  critical_misses integer not null default 0 check (critical_misses >= 0),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  computed_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.underwriting_settings(id, version, values)
values ('default', 1, '{"renovationPerM2":{"LIGHT":1000,"STANDARD":1800,"FULL":2700},"contingencyPercent":10,"purchaseTaxPercent":2,"fixedPurchaseCosts":3500,"purchaseCommissionPercent":0,"holdingMonths":6,"monthlyHoldingCost":1500,"financingEnabled":false,"financingAnnualRatePercent":9,"financingLoanPercent":70,"salesCostPercent":2,"minimumProfitPLN":50000,"minimumMarginPercent":12,"minimumROI":12,"targetNegotiationBufferPercent":5,"marketResalePerM2":{"low":0,"base":0,"high":0},"marketResaleProvenance":"USER_ASSUMPTION","decisionPolicy":{"criticalBuyFacts":["identity","askingPrice","areaM2","city","ownership","legalStatus","marketEvidence","renovationScope","economics","riskReview"],"minimumBuyConfidence":80,"maximumMarketFallbackLevel":3,"maximumMarketAgeDays":90,"minimumMarketComparableCount":3,"deepDiveValueThresholdPLN":400000}}'::jsonb)
on conflict (id) do nothing;

create or replace function public.set_investment_os_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
revoke all on function public.set_investment_os_updated_at() from public, anon, authenticated;
grant execute on function public.set_investment_os_updated_at() to service_role;

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at before update on public.deals for each row execute function public.set_investment_os_updated_at();
drop trigger if exists deal_evidence_set_updated_at on public.deal_evidence;
create trigger deal_evidence_set_updated_at before update on public.deal_evidence for each row execute function public.set_investment_os_updated_at();
drop trigger if exists director_information_requests_set_updated_at on public.director_information_requests;
create trigger director_information_requests_set_updated_at before update on public.director_information_requests for each row execute function public.set_investment_os_updated_at();
drop trigger if exists deal_fact_overrides_set_updated_at on public.deal_fact_overrides;
create trigger deal_fact_overrides_set_updated_at before update on public.deal_fact_overrides for each row execute function public.set_investment_os_updated_at();
drop trigger if exists market_assumptions_set_updated_at on public.market_assumptions;
create trigger market_assumptions_set_updated_at before update on public.market_assumptions for each row execute function public.set_investment_os_updated_at();
drop trigger if exists underwriting_settings_set_updated_at on public.underwriting_settings;
create trigger underwriting_settings_set_updated_at before update on public.underwriting_settings for each row execute function public.set_investment_os_updated_at();
drop trigger if exists deal_outcomes_set_updated_at on public.deal_outcomes;
create trigger deal_outcomes_set_updated_at before update on public.deal_outcomes for each row execute function public.set_investment_os_updated_at();
drop trigger if exists director_scorecards_set_updated_at on public.director_scorecards;
create trigger director_scorecards_set_updated_at before update on public.director_scorecards for each row execute function public.set_investment_os_updated_at();

alter table public.deals enable row level security;
alter table public.deal_evidence enable row level security;
alter table public.director_runs enable row level security;
alter table public.director_information_requests enable row level security;
alter table public.deal_fact_overrides enable row level security;
alter table public.market_assumptions enable row level security;
alter table public.underwriting_settings enable row level security;
alter table public.deal_outcomes enable row level security;
alter table public.director_scorecards enable row level security;

revoke all on table public.deals, public.deal_evidence, public.director_runs, public.director_information_requests, public.deal_fact_overrides, public.market_assumptions, public.underwriting_settings, public.deal_outcomes, public.director_scorecards from anon, authenticated;
grant select, insert, update on table public.deals, public.deal_evidence, public.director_runs, public.director_information_requests, public.deal_fact_overrides, public.market_assumptions, public.underwriting_settings, public.deal_outcomes, public.director_scorecards to service_role;

commit;
