begin;

-- Foundation history is additive. Existing listings and lifecycle remain the source of truth.
alter table if exists public.deal_evidence
  add column if not exists evidence_type text not null default 'LISTING_OBSERVATION',
  add column if not exists field text,
  add column if not exists supersedes_evidence_id text,
  add column if not exists content_hash text;

alter table if exists public.director_runs
  add column if not exists director_version integer not null default 1,
  add column if not exists attempt integer not null default 1,
  add column if not exists queued_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists stale_reason text;

do $$
begin
  if to_regclass('public.deal_evidence') is not null then
    alter table public.deal_evidence drop constraint if exists deal_evidence_evidence_type_check;
    alter table public.deal_evidence add constraint deal_evidence_evidence_type_check check (evidence_type in ('LISTING_OBSERVATION','PRICE_OBSERVATION','DOCUMENT_OBSERVATION','USER_INSPECTION','MANUAL_INPUT','AI_EXTRACTION','VISION_OBSERVATION','MARKET_COMPARABLE','MARKET_TRANSACTION','RENOVATION_QUOTE','ACTUAL_OUTCOME'));
    alter table public.deal_evidence drop constraint if exists deal_evidence_supersedes_evidence_id_fkey;
    alter table public.deal_evidence add constraint deal_evidence_supersedes_evidence_id_fkey foreign key (supersedes_evidence_id) references public.deal_evidence(id);
  end if;
  if to_regclass('public.director_runs') is not null then
    alter table public.director_runs drop constraint if exists director_runs_director_check;
    alter table public.director_runs drop constraint if exists director_runs_status_check;
    alter table public.director_runs add constraint director_runs_director_check check (director in ('SCOUT','VERIFY','MARKET','RISK','RENOVATION','UNDERWRITER','CFO','ACQUISITION','CEO'));
    alter table public.director_runs add constraint director_runs_status_check check (status in ('NOT_RUN','READY','QUEUED','RUNNING','COMPLETE','STALE','BLOCKED','FAILED'));
    alter table public.director_runs add constraint director_runs_director_version_check check (director_version > 0);
    alter table public.director_runs add constraint director_runs_attempt_check check (attempt > 0);
  end if;
end $$;

create table if not exists public.listing_fact_observations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  field text not null check (char_length(field) between 1 and 120),
  value jsonb not null,
  evidence_id text references public.deal_evidence(id),
  provenance text not null check (provenance in ('FACT','EXTRACTED','DERIVED','USER_ASSUMPTION','MARKET_ASSUMPTION','MANUAL_OVERRIDE','AI_INFERENCE','ESTIMATE','UNKNOWN')),
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  content_hash text not null check (char_length(content_hash) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint listing_fact_observations_valid_window check (valid_until is null or valid_from is null or valid_until >= valid_from),
  constraint listing_fact_observations_idempotency unique (listing_id, field, content_hash)
);

create index if not exists listing_fact_observations_deal_idx on public.listing_fact_observations(deal_id, observed_at desc);
create index if not exists listing_fact_observations_listing_idx on public.listing_fact_observations(listing_id, field, observed_at desc);

create table if not exists public.deal_fact_override_events (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  field text not null check (char_length(field) between 1 and 120),
  override_value jsonb,
  source_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_evidence_ids) = 'array'),
  conflict_status text not null default 'NONE' check (conflict_status in ('NONE','CRITICAL')),
  user_id text not null check (char_length(user_id) between 1 and 200),
  confirmation_reason text,
  confirmed_at timestamptz,
  content_hash text not null check (char_length(content_hash) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint deal_fact_override_events_confirmation check (confirmed_at is null or (confirmation_reason is not null and char_length(confirmation_reason) > 0)),
  constraint deal_fact_override_events_idempotency unique (deal_id, field, content_hash)
);

create index if not exists deal_fact_override_events_deal_idx on public.deal_fact_override_events(deal_id, created_at desc);

create table if not exists public.deal_fact_override_confirmations (
  id uuid primary key default gen_random_uuid(),
  override_event_id uuid not null references public.deal_fact_override_events(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  field text not null check (char_length(field) between 1 and 120),
  user_id text not null check (char_length(user_id) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  confirmed_at timestamptz not null default now(),
  constraint deal_fact_override_confirmations_idempotency unique (override_event_id, user_id)
);

create index if not exists deal_fact_override_confirmations_deal_idx on public.deal_fact_override_confirmations(deal_id, confirmed_at desc);

create table if not exists public.evidence_conflicts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  field text not null check (char_length(field) between 1 and 120),
  left_evidence_id text not null references public.deal_evidence(id),
  right_evidence_id text not null references public.deal_evidence(id),
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  resolution_evidence_id text references public.deal_evidence(id),
  created_at timestamptz not null default now(),
  constraint evidence_conflicts_distinct check (left_evidence_id <> right_evidence_id),
  constraint evidence_conflicts_idempotency unique (deal_id, field, left_evidence_id, right_evidence_id)
);

create index if not exists evidence_conflicts_deal_idx on public.evidence_conflicts(deal_id, created_at desc);

create table if not exists public.director_outputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.director_runs(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  director text not null check (director in ('VERIFY','MARKET','RISK','RENOVATION','UNDERWRITER','CFO','ACQUISITION')),
  director_version integer not null check (director_version > 0),
  input_fingerprint text not null,
  result jsonb,
  confidence_data numeric check (confidence_data is null or confidence_data between 0 and 100),
  confidence_method numeric check (confidence_method is null or confidence_method between 0 and 100),
  confidence_market numeric check (confidence_market is null or confidence_market between 0 and 100),
  evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
  missing_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_fields) = 'array'),
  conflicts jsonb not null default '[]'::jsonb check (jsonb_typeof(conflicts) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  recommendation text,
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  next_best_actions jsonb not null default '[]'::jsonb check (jsonb_typeof(next_best_actions) = 'array'),
  decision_triggers jsonb not null default '[]'::jsonb check (jsonb_typeof(decision_triggers) = 'array'),
  what_would_change_my_mind jsonb not null default '[]'::jsonb check (jsonb_typeof(what_would_change_my_mind) = 'array'),
  computed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint director_outputs_idempotency unique (deal_id, director, director_version, input_fingerprint)
);

create index if not exists director_outputs_deal_idx on public.director_outputs(deal_id, computed_at desc);
create index if not exists director_outputs_director_idx on public.director_outputs(director, computed_at desc);
create index if not exists director_outputs_fingerprint_idx on public.director_outputs(input_fingerprint);

create table if not exists public.ceo_decisions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  decision_version integer not null check (decision_version > 0),
  input_fingerprint text not null,
  internal_state text not null check (internal_state in ('HOT','GOOD','REVIEW','TOO_EXPENSIVE','REJECT')),
  user_facing_action text not null check (user_facing_action in ('JEDZ_OBEJRZEC','NEGOCJUJ','KUP','HOLD','ODRZUC')),
  gate_results jsonb not null default '[]'::jsonb check (jsonb_typeof(gate_results) = 'array'),
  dissent jsonb not null default '[]'::jsonb check (jsonb_typeof(dissent) = 'array'),
  conditions_to_proceed jsonb not null default '[]'::jsonb check (jsonb_typeof(conditions_to_proceed) = 'array'),
  walk_away_conditions jsonb not null default '[]'::jsonb check (jsonb_typeof(walk_away_conditions) = 'array'),
  missing_critical_information jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_critical_information) = 'array'),
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  source_director_output_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_director_output_ids) = 'array'),
  created_at timestamptz not null default now(),
  constraint ceo_decisions_idempotency unique (deal_id, decision_version, input_fingerprint)
);

create index if not exists ceo_decisions_deal_idx on public.ceo_decisions(deal_id, created_at desc);
create index if not exists ceo_decisions_fingerprint_idx on public.ceo_decisions(input_fingerprint);

create table if not exists public.deal_actual_outcomes (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  outcome_type text not null check (outcome_type in ('RESALE','RENOVATION','HOLDING','PROFIT','RISK_MISS','OTHER')),
  value jsonb not null,
  observed_at timestamptz not null,
  source_evidence_id text references public.deal_evidence(id),
  created_at timestamptz not null default now()
);

create index if not exists deal_actual_outcomes_deal_idx on public.deal_actual_outcomes(deal_id, observed_at desc);

-- One active run per deal/director is enforced in the database, not in UI code.
create unique index if not exists director_runs_one_active_idx on public.director_runs(deal_id, director)
where status in ('READY','QUEUED','RUNNING');

-- The projection and its append-only override event are committed together.
create or replace function public.apply_investment_override(
  p_deal_id uuid,
  p_values jsonb,
  p_invalidated text[] default '{}',
  p_events jsonb default '[]'::jsonb,
  p_user_id text default 'application'
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_deal_id is null or jsonb_typeof(coalesce(p_values, '{}'::jsonb)) <> 'object' then
    raise exception 'INVESTMENT_OVERRIDE_INVALID';
  end if;
  insert into public.deal_fact_overrides(deal_id, values, updated_at)
  values (p_deal_id, coalesce(p_values, '{}'::jsonb), now())
  on conflict (deal_id) do update set values = excluded.values, updated_at = now();

  update public.deals
  set verify = case when 'VERIFY' = any(p_invalidated) then jsonb_set(coalesce(verify, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else verify end,
      market = case when 'MARKET' = any(p_invalidated) then jsonb_set(coalesce(market, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else market end,
      underwriting = case when 'UNDERWRITER' = any(p_invalidated) then jsonb_set(coalesce(underwriting, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else underwriting end,
      ceo = case when 'CEO' = any(p_invalidated) then jsonb_set(coalesce(ceo, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else ceo end,
      updated_at = now()
  where id = p_deal_id;

  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) = 'array' then
    insert into public.deal_fact_override_events(deal_id, field, override_value, source_evidence_ids, conflict_status, user_id, confirmation_reason, confirmed_at, content_hash)
    select p_deal_id, left(entry->>'field', 120), entry->'overrideValue', coalesce(entry->'sourceEvidenceIds', '[]'::jsonb),
      case when entry->>'conflictStatus' in ('NONE','CRITICAL') then entry->>'conflictStatus' else 'NONE' end,
      left(coalesce(nullif(p_user_id, ''), 'application'), 200), null, null, left(coalesce(entry->>'contentHash', md5(entry::text)), 200)
    from jsonb_array_elements(p_events) as entry
    where jsonb_typeof(entry) = 'object' and nullif(entry->>'field', '') is not null
    on conflict (deal_id, field, content_hash) do nothing;
  end if;
end;
$$;
revoke all on function public.apply_investment_override(uuid, jsonb, text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_investment_override(uuid, jsonb, text[], jsonb, text) to service_role;

create or replace function public.confirm_investment_override(
  p_override_event_id uuid,
  p_deal_id uuid,
  p_field text,
  p_user_id text,
  p_reason text,
  p_confirmed_at timestamptz default now()
)
returns uuid language plpgsql security definer set search_path = public as $$
declare confirmation_id uuid;
begin
  if p_override_event_id is null or p_deal_id is null or nullif(trim(p_field), '') is null or nullif(trim(p_user_id), '') is null or nullif(trim(p_reason), '') is null then
    raise exception 'OVERRIDE_CONFIRMATION_INVALID';
  end if;
  insert into public.deal_fact_override_confirmations(override_event_id, deal_id, field, user_id, reason, confirmed_at)
  values (p_override_event_id, p_deal_id, left(trim(p_field), 120), left(trim(p_user_id), 200), left(trim(p_reason), 500), coalesce(p_confirmed_at, now()))
  on conflict (override_event_id, user_id) do nothing
  returning id into confirmation_id;
  if confirmation_id is null then
    select id into confirmation_id from public.deal_fact_override_confirmations where override_event_id = p_override_event_id and user_id = left(trim(p_user_id), 200) limit 1;
  end if;
  return confirmation_id;
end;
$$;
revoke all on function public.confirm_investment_override(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.confirm_investment_override(uuid, uuid, text, text, text, timestamptz) to service_role;

create or replace function public.prevent_investment_history_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'INVESTMENT_HISTORY_APPEND_ONLY:%', TG_TABLE_NAME;
end;
$$;
revoke all on function public.prevent_investment_history_mutation() from public, anon, authenticated;
grant execute on function public.prevent_investment_history_mutation() to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['listing_fact_observations','deal_fact_override_events','deal_fact_override_confirmations','evidence_conflicts','director_outputs','ceo_decisions','deal_actual_outcomes'] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_append_only', table_name);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.prevent_investment_history_mutation()', table_name || '_append_only', table_name);
  end loop;
  if to_regclass('public.deal_evidence') is not null then
    drop trigger if exists deal_evidence_append_only on public.deal_evidence;
    create trigger deal_evidence_append_only before update or delete on public.deal_evidence for each row execute function public.prevent_investment_history_mutation();
  end if;
  if to_regclass('public.director_runs') is not null then
    drop trigger if exists director_runs_append_only on public.director_runs;
    create trigger director_runs_append_only before update or delete on public.director_runs for each row execute function public.prevent_investment_history_mutation();
  end if;
end $$;

alter table public.deal_evidence enable row level security;
alter table public.director_runs enable row level security;
alter table public.listing_fact_observations enable row level security;
alter table public.deal_fact_override_events enable row level security;
alter table public.deal_fact_override_confirmations enable row level security;
alter table public.evidence_conflicts enable row level security;
alter table public.director_outputs enable row level security;
alter table public.ceo_decisions enable row level security;
alter table public.deal_actual_outcomes enable row level security;

revoke all on table public.deal_evidence, public.director_runs, public.listing_fact_observations, public.deal_fact_override_events, public.deal_fact_override_confirmations, public.evidence_conflicts, public.director_outputs, public.ceo_decisions, public.deal_actual_outcomes from anon, authenticated;
grant select, insert on table public.deal_evidence, public.director_runs, public.listing_fact_observations, public.deal_fact_override_events, public.deal_fact_override_confirmations, public.evidence_conflicts, public.director_outputs, public.ceo_decisions, public.deal_actual_outcomes to service_role;
revoke update, delete on table public.deal_evidence, public.director_runs, public.listing_fact_observations, public.deal_fact_override_events, public.deal_fact_override_confirmations, public.evidence_conflicts, public.director_outputs, public.ceo_decisions, public.deal_actual_outcomes from service_role;

commit;
