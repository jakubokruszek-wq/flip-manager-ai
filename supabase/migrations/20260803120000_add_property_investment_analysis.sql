begin;

alter table public.properties
  add column if not exists flip_score numeric,
  add column if not exists ai_analysis jsonb,
  add column if not exists market_intelligence jsonb,
  add column if not exists estimated_after_renovation_price numeric,
  add column if not exists estimated_after_renovation_price_per_sqm numeric,
  add column if not exists comparable_count integer,
  add column if not exists market_percentile numeric,
  add column if not exists recommended_max_price numeric,
  add column if not exists negotiation_target numeric,
  add column if not exists purchase_decision text,
  add column if not exists target_profit numeric,
  add column if not exists target_roi numeric,
  add column if not exists calculator_data jsonb,
  add column if not exists analysis_completed_at timestamptz;

alter table public.properties
  drop constraint if exists properties_purchase_decision_check;

alter table public.properties
  add constraint properties_purchase_decision_check
  check (purchase_decision is null or purchase_decision in ('buy', 'negotiate', 'reject'));

alter table public.properties
  drop constraint if exists properties_comparable_count_nonnegative;

alter table public.properties
  add constraint properties_comparable_count_nonnegative
  check (comparable_count is null or comparable_count >= 0);

commit;
