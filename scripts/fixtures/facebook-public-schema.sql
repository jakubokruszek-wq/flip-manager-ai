-- Schema-only public application catalog, captured read-only 2026-10-15.
-- NO ROW DATA. Managed auth/storage are not included; isolated bootstrap supplies auth.uid/role.
-- Test fixture only: never apply to an existing database.
SET check_function_bodies = off;

CREATE TABLE public.alert_preferences (
  id text NOT NULL DEFAULT 'default'::text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.alert_preferences ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.alerts (
  id text NOT NULL,
  event_key text NOT NULL,
  type text NOT NULL,
  listing_id uuid NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  seller_type text,
  price numeric,
  neighborhood text,
  city text,
  price_per_sqm numeric,
  flip_score numeric,
  opportunity_score numeric,
  detected_at timestamp with time zone NOT NULL,
  read_at timestamp with time zone,
  details_url text NOT NULL,
  original_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  area numeric,
  condition text,
  group_name text,
  flags text[] NOT NULL DEFAULT '{}'::text[],
  push_delivered_at timestamp with time zone
);
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ceo_decisions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  decision_version integer NOT NULL,
  input_fingerprint text NOT NULL,
  internal_state text NOT NULL,
  user_facing_action text NOT NULL,
  gate_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  dissent jsonb NOT NULL DEFAULT '[]'::jsonb,
  conditions_to_proceed jsonb NOT NULL DEFAULT '[]'::jsonb,
  walk_away_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_critical_information jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_director_output_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.ceo_decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.collector_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_name text NOT NULL,
  installation_id text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  last_heartbeat_at timestamp with time zone,
  last_source_scan_at timestamp with time zone,
  last_captured_count integer NOT NULL DEFAULT 0,
  health_status text NOT NULL DEFAULT 'FAILED'::text
);
ALTER TABLE public.collector_devices ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.collector_imports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  listing_id uuid,
  idempotency_key text NOT NULL,
  source_post_url text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received'::text,
  error_message text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.collector_imports ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.collector_request_nonces (
  device_id uuid NOT NULL,
  nonce text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.collector_request_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.collector_scan_batches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  source_id text NOT NULL,
  source_type text NOT NULL,
  source_url text NOT NULL,
  status text NOT NULL DEFAULT 'received'::text,
  health_status text NOT NULL,
  visible_card_count integer NOT NULL DEFAULT 0,
  captured_post_count integer NOT NULL DEFAULT 0,
  capture_ratio numeric NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone
);
ALTER TABLE public.collector_scan_batches ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_actual_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  outcome_type text NOT NULL,
  value jsonb NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  source_evidence_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_actual_outcomes ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_evidence (
  id text NOT NULL,
  deal_id uuid NOT NULL,
  type text NOT NULL,
  source_type text NOT NULL,
  source_name text NOT NULL,
  structured_payload jsonb NOT NULL DEFAULT 'null'::jsonb,
  source_url text,
  document_id text,
  observed_at timestamp with time zone,
  valid_from timestamp with time zone,
  valid_until timestamp with time zone,
  reliability integer NOT NULL,
  confidence integer NOT NULL,
  director_who_requested text NOT NULL,
  verification_status text NOT NULL,
  conflicts_with jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  evidence_type text NOT NULL DEFAULT 'LISTING_OBSERVATION'::text,
  field text,
  supersedes_evidence_id text,
  content_hash text
);
ALTER TABLE public.deal_evidence ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_fact_override_confirmations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  override_event_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  field text NOT NULL,
  user_id text NOT NULL,
  reason text NOT NULL,
  confirmed_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_fact_override_confirmations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_fact_override_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  field text NOT NULL,
  override_value jsonb,
  source_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflict_status text NOT NULL DEFAULT 'NONE'::text,
  user_id text NOT NULL,
  confirmation_reason text,
  confirmed_at timestamp with time zone,
  content_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_fact_override_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_fact_overrides (
  deal_id uuid NOT NULL,
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_fact_overrides ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deal_outcomes (
  deal_id uuid NOT NULL,
  actual_resale_value numeric,
  actual_renovation_cost numeric,
  actual_duration_days integer,
  actual_profit numeric,
  risk_misses jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.deal_outcomes ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'DISCOVERED'::text,
  facts_fingerprint text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  scout jsonb NOT NULL DEFAULT '{}'::jsonb,
  verify jsonb NOT NULL DEFAULT '{}'::jsonb,
  market jsonb NOT NULL DEFAULT '{}'::jsonb,
  underwriting jsonb NOT NULL DEFAULT '{}'::jsonb,
  ceo jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_fabric jsonb NOT NULL DEFAULT '[]'::jsonb,
  information_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis_level integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  source_updated_at timestamp with time zone
);
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.director_information_requests (
  id text NOT NULL,
  deal_id uuid NOT NULL,
  field text NOT NULL,
  question text NOT NULL,
  priority text NOT NULL,
  value_of_information integer NOT NULL,
  decision_impact jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by text NOT NULL,
  evidence_needed text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.director_information_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.director_outputs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  director text NOT NULL,
  director_version integer NOT NULL,
  input_fingerprint text NOT NULL,
  result jsonb,
  confidence_data numeric,
  confidence_method numeric,
  confidence_market numeric,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_best_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  what_would_change_my_mind jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.director_outputs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.director_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  director text NOT NULL,
  input_fingerprint text NOT NULL,
  output_version integer NOT NULL,
  status text NOT NULL,
  tools_requested jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_succeeded jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_failed jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence integer NOT NULL,
  elapsed_ms integer NOT NULL,
  computed_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  director_version integer NOT NULL DEFAULT 1,
  attempt integer NOT NULL DEFAULT 1,
  queued_at timestamp with time zone,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  failure_reason text,
  stale_reason text
);
ALTER TABLE public.director_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.director_scorecards (
  director text NOT NULL,
  deal_count integer NOT NULL DEFAULT 0,
  median_error_percent numeric,
  p90_error_percent numeric,
  confidence_calibration text,
  critical_misses integer NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.director_scorecards ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.evidence_conflicts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  field text NOT NULL,
  left_evidence_id text NOT NULL,
  right_evidence_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN'::text,
  resolution_evidence_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.evidence_conflicts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.facebook_group_discovery_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  device_id uuid,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone
);
ALTER TABLE public.facebook_group_discovery_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.facebook_scan_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scan_run_id uuid NOT NULL,
  source_scan_id uuid,
  search_filter_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'::text,
  group_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamp with time zone NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamp with time zone,
  heartbeat_at timestamp with time zone,
  worker_id text,
  result_summary jsonb,
  error_code text,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  consumer_type text NOT NULL DEFAULT 'LEGACY_WORKER'::text,
  job_type text NOT NULL DEFAULT 'SOURCE_SCAN'::text,
  priority integer NOT NULL DEFAULT 0,
  gallery_listing_id uuid,
  gallery_post_id text,
  gallery_source_url text
);
ALTER TABLE public.facebook_scan_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.facebook_worker_nonces (
  nonce text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);
ALTER TABLE public.facebook_worker_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.finder_building_type_confirmations (
  listing_id uuid NOT NULL,
  building_type text NOT NULL,
  confirmed_by uuid NOT NULL,
  confirmed_at timestamp with time zone NOT NULL DEFAULT now(),
  note text
);
ALTER TABLE public.finder_building_type_confirmations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.finder_listing_identity_decisions (
  owner_id uuid NOT NULL,
  search_filter_id uuid NOT NULL,
  listing_a uuid NOT NULL,
  listing_b uuid NOT NULL,
  decision text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.finder_listing_identity_decisions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.finder_listing_identity_groups (
  owner_id uuid NOT NULL,
  search_filter_id uuid NOT NULL,
  group_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.finder_listing_identity_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.finder_olx_slots (
  search_filter_id uuid NOT NULL,
  slot_at timestamp with time zone NOT NULL,
  status text NOT NULL,
  reason text,
  job_id uuid,
  decided_at timestamp with time zone NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.finder_olx_slots ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.gallery_request_traces (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trace_id text NOT NULL,
  listing_id uuid NOT NULL,
  post_id text,
  event text NOT NULL,
  gallery_status text NOT NULL,
  client_timestamp timestamp with time zone,
  target_tag text,
  current_target_tag text,
  disabled boolean,
  pointer_events text,
  guard_reason text,
  http_status integer,
  response_ok boolean,
  error_code text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  source text,
  client_build text,
  component text,
  button_rendered boolean,
  instance_id text,
  action_stage text,
  error_name text,
  error_message text,
  closest_button_found boolean
);
ALTER TABLE public.gallery_request_traces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listing_fact_observations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  field text NOT NULL,
  value jsonb NOT NULL,
  evidence_id text,
  provenance text NOT NULL,
  observed_at timestamp with time zone,
  valid_from timestamp with time zone,
  valid_until timestamp with time zone,
  content_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.listing_fact_observations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listing_filter_match_audit (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  search_filter_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  previous_state text NOT NULL,
  new_state text NOT NULL,
  reason text NOT NULL,
  scan_run_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.listing_filter_match_audit ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listing_filter_matches (
  listing_id uuid NOT NULL,
  search_filter_id uuid NOT NULL,
  first_matched_at timestamp with time zone NOT NULL DEFAULT now(),
  last_matched_at timestamp with time zone NOT NULL DEFAULT now(),
  match_score numeric,
  match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_current_match boolean NOT NULL DEFAULT true,
  match_origin text NOT NULL DEFAULT 'scan'::text,
  source_scan_id uuid
);
ALTER TABLE public.listing_filter_matches ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listing_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  captured_at timestamp with time zone NOT NULL DEFAULT now(),
  price numeric,
  title text,
  description text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.listing_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listing_source_metadata (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL,
  source text NOT NULL,
  source_post_url text NOT NULL,
  group_name text,
  author_name text,
  published_at timestamp with time zone,
  collected_at timestamp with time zone NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.listing_source_metadata ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_listing_id text NOT NULL,
  original_url text NOT NULL,
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
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'::text,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  removed_at timestamp with time zone,
  content_hash text,
  flip_score numeric,
  estimated_renovation_cost numeric,
  estimated_sale_price numeric,
  estimated_profit numeric,
  estimated_roi numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  review_reason text,
  missing_fields jsonb DEFAULT '[]'::jsonb,
  manual_decision text,
  manual_decision_reason text,
  lifecycle_status text DEFAULT 'ACTIVE'::text,
  archived_at timestamp with time zone,
  gallery_status text NOT NULL DEFAULT 'NOT_REQUESTED'::text,
  gallery_job_id uuid,
  gallery_requested_at timestamp with time zone,
  gallery_completed_at timestamp with time zone,
  gallery_error text,
  gallery_total integer NOT NULL DEFAULT 0,
  gallery_persisted_count integer NOT NULL DEFAULT 0,
  cross_source_identity text,
  identity_evidence jsonb
);
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.market_assumptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  city text NOT NULL,
  district text,
  building_type text,
  area_min numeric,
  area_max numeric,
  rooms numeric,
  resale_price_per_m2_low numeric NOT NULL,
  resale_price_per_m2_base numeric NOT NULL,
  resale_price_per_m2_high numeric NOT NULL,
  confidence integer NOT NULL,
  provenance text NOT NULL DEFAULT 'USER_ASSUMPTION'::text,
  effective_from timestamp with time zone NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.market_assumptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.olx_automation_control (
  id smallint NOT NULL DEFAULT 1,
  scheduled_claim_enabled boolean NOT NULL DEFAULT false,
  unclaimed_expiry_minutes integer NOT NULL DEFAULT 360,
  max_claims_24h integer NOT NULL DEFAULT 1,
  note text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.olx_automation_control ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.olx_cloud_budget (
  worker_id text NOT NULL,
  reported_at timestamp with time zone NOT NULL DEFAULT now(),
  utc_day date NOT NULL,
  account_browser_ms integer NOT NULL,
  worker_browser_ms integer NOT NULL,
  safe_budget_ms integer NOT NULL,
  job_estimate_ms integer NOT NULL
);
ALTER TABLE public.olx_cloud_budget ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.olx_scan_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scan_run_id uuid NOT NULL,
  source_scan_id uuid,
  search_filter_id uuid,
  status text NOT NULL DEFAULT 'queued'::text,
  request_url text NOT NULL,
  filter_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamp with time zone NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamp with time zone,
  heartbeat_at timestamp with time zone,
  worker_id text,
  result_summary jsonb,
  error_code text,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  context_type text NOT NULL DEFAULT 'finder'::text,
  radar_owner_id uuid,
  radar_run_id uuid,
  radar_lease_token uuid,
  requested_by text
);
ALTER TABLE public.olx_scan_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.olx_worker_nonces (
  nonce text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);
ALTER TABLE public.olx_worker_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.price_radar_district_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source text NOT NULL,
  external_listing_id text NOT NULL,
  original_url text NOT NULL,
  normalized_url text NOT NULL,
  title text,
  description text,
  price numeric NOT NULL,
  area numeric NOT NULL,
  price_per_sqm numeric NOT NULL,
  rooms integer,
  city text NOT NULL,
  building_type text NOT NULL,
  market_type text NOT NULL,
  renovation_status text NOT NULL,
  content_hash text NOT NULL,
  cross_source_identity text,
  published_at timestamp with time zone,
  source_updated_at timestamp with time zone,
  collected_at timestamp with time zone NOT NULL DEFAULT now(),
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'::text,
  suggested_district text,
  suggestion_source text,
  suggestion_evidence text,
  assigned_district text,
  assigned_by uuid,
  assigned_at timestamp with time zone,
  assignment_origin text,
  rejected_at timestamp with time zone,
  radar_listing_id uuid
);
ALTER TABLE public.price_radar_district_queue ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.price_radar_listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source text NOT NULL,
  external_listing_id text NOT NULL,
  original_url text NOT NULL,
  normalized_url text NOT NULL,
  title text,
  description text,
  price numeric NOT NULL,
  area numeric NOT NULL,
  price_per_sqm numeric NOT NULL,
  rooms integer,
  city text NOT NULL,
  district text NOT NULL,
  building_type text NOT NULL,
  market_type text NOT NULL,
  renovation_status text NOT NULL,
  content_hash text NOT NULL,
  cross_source_identity text,
  published_at timestamp with time zone,
  source_updated_at timestamp with time zone,
  collected_at timestamp with time zone NOT NULL DEFAULT now(),
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active'::text,
  excluded_at timestamp with time zone,
  excluded_reason text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.price_radar_listings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.price_radar_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_statuses jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_token uuid,
  lease_until timestamp with time zone,
  scanned_count integer NOT NULL DEFAULT 0,
  qualified_count integer NOT NULL DEFAULT 0,
  error_message text,
  stop_requested_at timestamp with time zone,
  user_terminated_at timestamp with time zone
);
ALTER TABLE public.price_radar_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.price_radar_settings (
  owner_id uuid NOT NULL,
  filters jsonb NOT NULL DEFAULT '{"rooms": [], "market": "both", "areaMax": null, "areaMin": null, "sources": [], "districts": ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"]}'::jsonb,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.price_radar_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.price_radar_verification_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source text NOT NULL,
  external_listing_id text NOT NULL,
  original_url text NOT NULL,
  normalized_url text NOT NULL,
  title text,
  source_snapshot jsonb NOT NULL,
  confirmed_fields text[] NOT NULL DEFAULT '{}'::text[],
  missing_fields text[] NOT NULL DEFAULT '{}'::text[],
  contradictory_fields text[] NOT NULL DEFAULT '{}'::text[],
  routing_reasons text[] NOT NULL DEFAULT '{}'::text[],
  field_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  suggested_district text,
  suggestion_evidence text,
  status text NOT NULL DEFAULT 'pending'::text,
  operator_decision jsonb,
  decision_at timestamp with time zone,
  decision_by uuid,
  rejected_at timestamp with time zone,
  radar_listing_id uuid,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.price_radar_verification_queue ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.properties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT now(),
  title text NOT NULL,
  address text,
  city text,
  price numeric,
  area numeric,
  rooms integer,
  floor integer,
  building_floors integer,
  year_built integer,
  status text DEFAULT 'new'::text,
  notes text,
  building_type text,
  ownership text,
  rent numeric,
  district text,
  original_url text,
  source text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  listing_id uuid,
  flip_score numeric,
  ai_analysis jsonb,
  market_intelligence jsonb,
  estimated_after_renovation_price numeric,
  estimated_after_renovation_price_per_sqm numeric,
  comparable_count integer,
  market_percentile numeric,
  recommended_max_price numeric,
  negotiation_target numeric,
  purchase_decision text,
  target_profit numeric,
  target_roi numeric,
  calculator_data jsonb,
  analysis_completed_at timestamp with time zone,
  normalized_url text,
  external_listing_id text,
  investment_analysis jsonb,
  purchase_tax numeric,
  notary_cost numeric,
  purchase_commission numeric,
  renovation_cost numeric,
  furnishing_cost numeric,
  reserve_cost numeric,
  expected_sale_price numeric,
  sale_commission numeric,
  tax_cost numeric,
  total_cost numeric,
  revenue numeric,
  profit numeric,
  roi numeric,
  margin numeric,
  total_floors integer,
  cross_source_identity text
);
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true
);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.resale_comp_price_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  comp_id uuid NOT NULL,
  observed_at timestamp with time zone NOT NULL DEFAULT now(),
  price numeric,
  price_per_m2 numeric
);
ALTER TABLE public.resale_comp_price_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.resale_comps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL,
  external_listing_id text NOT NULL,
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
  renovation_status text NOT NULL DEFAULT 'UNKNOWN'::text,
  renovation_confidence text NOT NULL DEFAULT 'LOW'::text,
  finish_level text,
  listing_created_at timestamp with time zone,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  seller_type text,
  fingerprint text,
  outlier_reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.resale_comps ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.search_filters (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  city text,
  districts jsonb NOT NULL DEFAULT '[]'::jsonb,
  price_min numeric,
  price_max numeric,
  area_min numeric,
  area_max numeric,
  rooms jsonb NOT NULL DEFAULT '[]'::jsonb,
  floor_min numeric,
  floor_max numeric,
  exclude_ground_floor boolean NOT NULL DEFAULT false,
  exclude_top_floor boolean NOT NULL DEFAULT false,
  building_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  ownership_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  market_type text,
  private_only boolean NOT NULL DEFAULT false,
  max_price_per_sqm numeric,
  required_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluded_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  min_flip_score numeric,
  min_estimated_profit numeric,
  max_estimated_renovation_cost numeric,
  scan_interval_minutes integer NOT NULL DEFAULT 60,
  is_active boolean NOT NULL DEFAULT true,
  last_scanned_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  finder_scan_interval_minutes integer NOT NULL DEFAULT 60,
  finder_olx_scan_interval_minutes integer NOT NULL DEFAULT 1440,
  finder_olx_start_time time without time zone NOT NULL DEFAULT '08:00:00'::time without time zone,
  finder_olx_schedule_anchor timestamp without time zone NOT NULL
);
ALTER TABLE public.search_filters ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.source_scans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  search_filter_id uuid NOT NULL,
  source text NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  status text NOT NULL DEFAULT 'running'::text,
  listings_found integer NOT NULL DEFAULT 0,
  listings_created integer NOT NULL DEFAULT 0,
  listings_updated integer NOT NULL DEFAULT 0,
  error_message text,
  filter_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  scanned_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  price_drop_count integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_run_id uuid,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  continuation_attempt integer NOT NULL DEFAULT 0,
  continuation_next_at timestamp with time zone,
  continuation_cycle_at timestamp with time zone,
  continuation_lease_token uuid,
  continuation_lease_until timestamp with time zone
);
ALTER TABLE public.source_scans ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.underwriting_settings (
  id text NOT NULL DEFAULT 'default'::text,
  version integer NOT NULL DEFAULT 1,
  "values" jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.underwriting_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.watched_facebook_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  city text NOT NULL DEFAULT 'Łódź'::text,
  district text,
  neighborhood text,
  priority text NOT NULL DEFAULT 'normal'::text,
  keywords text[] NOT NULL DEFAULT '{}'::text[],
  enabled boolean NOT NULL DEFAULT true,
  access_status text NOT NULL DEFAULT 'MANUAL_IMPORT'::text,
  last_checked_at timestamp with time zone,
  imported_posts_count integer NOT NULL DEFAULT 0,
  new_today_count integer NOT NULL DEFAULT 0,
  opportunities_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  name_verified boolean NOT NULL DEFAULT true
);
ALTER TABLE public.watched_facebook_groups ENABLE ROW LEVEL SECURITY;

ALTER TABLE alert_preferences ADD CONSTRAINT alert_preferences_pkey PRIMARY KEY (id);
ALTER TABLE alerts ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_pkey PRIMARY KEY (id);
ALTER TABLE collector_devices ADD CONSTRAINT collector_devices_pkey PRIMARY KEY (id);
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_pkey PRIMARY KEY (id);
ALTER TABLE collector_request_nonces ADD CONSTRAINT collector_request_nonces_pkey PRIMARY KEY (device_id, nonce);
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_pkey PRIMARY KEY (id);
ALTER TABLE deal_actual_outcomes ADD CONSTRAINT deal_actual_outcomes_pkey PRIMARY KEY (id);
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_pkey PRIMARY KEY (id);
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_pkey PRIMARY KEY (id);
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_pkey PRIMARY KEY (id);
ALTER TABLE deal_fact_overrides ADD CONSTRAINT deal_fact_overrides_pkey PRIMARY KEY (deal_id);
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_pkey PRIMARY KEY (deal_id);
ALTER TABLE deals ADD CONSTRAINT deals_pkey PRIMARY KEY (id);
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_pkey PRIMARY KEY (id);
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_pkey PRIMARY KEY (id);
ALTER TABLE director_runs ADD CONSTRAINT director_runs_pkey PRIMARY KEY (id);
ALTER TABLE director_scorecards ADD CONSTRAINT director_scorecards_pkey PRIMARY KEY (director);
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_pkey PRIMARY KEY (id);
ALTER TABLE facebook_group_discovery_sessions ADD CONSTRAINT facebook_group_discovery_sessions_pkey PRIMARY KEY (id);
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_pkey PRIMARY KEY (id);
ALTER TABLE facebook_worker_nonces ADD CONSTRAINT facebook_worker_nonces_pkey PRIMARY KEY (nonce);
ALTER TABLE finder_building_type_confirmations ADD CONSTRAINT finder_building_type_confirmations_pkey PRIMARY KEY (listing_id);
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_pkey PRIMARY KEY (owner_id, search_filter_id, listing_a, listing_b);
ALTER TABLE finder_listing_identity_groups ADD CONSTRAINT finder_listing_identity_groups_pkey PRIMARY KEY (owner_id, search_filter_id, listing_id);
ALTER TABLE finder_olx_slots ADD CONSTRAINT finder_olx_slots_pkey PRIMARY KEY (search_filter_id, slot_at);
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_pkey PRIMARY KEY (id);
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_pkey PRIMARY KEY (id);
ALTER TABLE listing_filter_match_audit ADD CONSTRAINT listing_filter_match_audit_pkey PRIMARY KEY (id);
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_pkey PRIMARY KEY (listing_id, search_filter_id);
ALTER TABLE listing_snapshots ADD CONSTRAINT listing_snapshots_pkey PRIMARY KEY (id);
ALTER TABLE listing_source_metadata ADD CONSTRAINT listing_source_metadata_pkey PRIMARY KEY (id);
ALTER TABLE listings ADD CONSTRAINT listings_pkey PRIMARY KEY (id);
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_pkey PRIMARY KEY (id);
ALTER TABLE olx_automation_control ADD CONSTRAINT olx_automation_control_pkey PRIMARY KEY (id);
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_pkey PRIMARY KEY (worker_id);
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_pkey PRIMARY KEY (id);
ALTER TABLE olx_worker_nonces ADD CONSTRAINT olx_worker_nonces_pkey PRIMARY KEY (nonce);
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_pkey PRIMARY KEY (id);
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_pkey PRIMARY KEY (id);
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_pkey PRIMARY KEY (id);
ALTER TABLE price_radar_settings ADD CONSTRAINT price_radar_settings_pkey PRIMARY KEY (owner_id);
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_pkey PRIMARY KEY (id);
ALTER TABLE properties ADD CONSTRAINT properties_pkey PRIMARY KEY (id);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE resale_comp_price_history ADD CONSTRAINT resale_comp_price_history_pkey PRIMARY KEY (id);
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_pkey PRIMARY KEY (id);
ALTER TABLE search_filters ADD CONSTRAINT search_filters_pkey PRIMARY KEY (id);
ALTER TABLE source_scans ADD CONSTRAINT source_scans_pkey PRIMARY KEY (id);
ALTER TABLE underwriting_settings ADD CONSTRAINT underwriting_settings_pkey PRIMARY KEY (id);
ALTER TABLE watched_facebook_groups ADD CONSTRAINT watched_facebook_groups_pkey PRIMARY KEY (id);
ALTER TABLE alerts ADD CONSTRAINT alerts_event_key_key UNIQUE (event_key);
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_idempotency UNIQUE (deal_id, decision_version, input_fingerprint);
ALTER TABLE collector_devices ADD CONSTRAINT collector_devices_installation_id_key UNIQUE (installation_id);
ALTER TABLE collector_devices ADD CONSTRAINT collector_devices_token_hash_key UNIQUE (token_hash);
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_device_idempotency_key_key UNIQUE (device_id, idempotency_key);
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_device_batch_unique UNIQUE (device_id, batch_id);
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_idempotency UNIQUE (override_event_id, user_id);
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_idempotency UNIQUE (deal_id, field, content_hash);
ALTER TABLE deals ADD CONSTRAINT deals_listing_id_key UNIQUE (listing_id);
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_idempotency UNIQUE (deal_id, director, director_version, input_fingerprint);
ALTER TABLE director_runs ADD CONSTRAINT director_runs_idempotency UNIQUE (deal_id, director, input_fingerprint, output_version);
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_idempotency UNIQUE (deal_id, field, left_evidence_id, right_evidence_id);
ALTER TABLE facebook_group_discovery_sessions ADD CONSTRAINT facebook_group_discovery_sessions_token_hash_key UNIQUE (token_hash);
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_idempotency UNIQUE (listing_id, field, content_hash);
ALTER TABLE listing_source_metadata ADD CONSTRAINT listing_source_metadata_source_post_url_key UNIQUE (source, source_post_url);
ALTER TABLE listings ADD CONSTRAINT listings_source_external_listing_id_key UNIQUE (source, external_listing_id);
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_source_scan_id_key UNIQUE (source_scan_id);
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_owner_source_external_key UNIQUE (owner_id, source, external_listing_id);
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_owner_source_external_key UNIQUE (owner_id, source, external_listing_id);
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_owner_source_url_key UNIQUE (owner_id, source, normalized_url);
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_owner_source_external_key UNIQUE (owner_id, source, external_listing_id);
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_owner_source_url_key UNIQUE (owner_id, source, normalized_url);
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
ALTER TABLE watched_facebook_groups ADD CONSTRAINT watched_facebook_groups_url_key UNIQUE (url);
ALTER TABLE alert_preferences ADD CONSTRAINT alert_preferences_settings_object CHECK ((jsonb_typeof(settings) = 'object'::text));
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK ((type = ANY (ARRAY['facebook_opportunity'::text, 'high_flip_score'::text, 'price_drop'::text, 'private_seller'::text, 'new_listing'::text, 'canonical_match'::text])));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_conditions_to_proceed_check CHECK ((jsonb_typeof(conditions_to_proceed) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_decision_version_check CHECK ((decision_version > 0));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_dissent_check CHECK ((jsonb_typeof(dissent) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_gate_results_check CHECK ((jsonb_typeof(gate_results) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_internal_state_check CHECK ((internal_state = ANY (ARRAY['HOT'::text, 'GOOD'::text, 'REVIEW'::text, 'TOO_EXPENSIVE'::text, 'REJECT'::text])));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_missing_critical_information_check CHECK ((jsonb_typeof(missing_critical_information) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_reason_codes_check CHECK ((jsonb_typeof(reason_codes) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_source_director_output_ids_check CHECK ((jsonb_typeof(source_director_output_ids) = 'array'::text));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_user_facing_action_check CHECK ((user_facing_action = ANY (ARRAY['JEDZ_OBEJRZEC'::text, 'NEGOCJUJ'::text, 'KUP'::text, 'HOLD'::text, 'ODRZUC'::text])));
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_walk_away_conditions_check CHECK ((jsonb_typeof(walk_away_conditions) = 'array'::text));
ALTER TABLE collector_devices ADD CONSTRAINT collector_devices_health_status_check CHECK ((health_status = ANY (ARRAY['HEALTHY'::text, 'DEGRADED'::text, 'FAILED'::text])));
ALTER TABLE collector_devices ADD CONSTRAINT collector_devices_last_captured_count_check CHECK ((last_captured_count >= 0));
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_payload_object CHECK ((jsonb_typeof(payload) = 'object'::text));
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_result_object CHECK ((jsonb_typeof(result) = 'object'::text));
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_status_check CHECK ((status = ANY (ARRAY['received'::text, 'imported'::text, 'pending_review'::text, 'failed'::text])));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_capture_ratio_check CHECK (((capture_ratio >= (0)::numeric) AND (capture_ratio <= (1)::numeric)));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_captured_post_count_check CHECK ((captured_post_count >= 0));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_health_status_check CHECK ((health_status = ANY (ARRAY['HEALTHY'::text, 'DEGRADED'::text, 'FAILED'::text])));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_payload_object CHECK ((jsonb_typeof(payload) = 'object'::text));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_result_object CHECK ((jsonb_typeof(result) = 'object'::text));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_source_type_check CHECK ((source_type = ANY (ARRAY['GROUP'::text, 'PROFILE'::text])));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processing'::text, 'completed'::text, 'degraded'::text, 'failed'::text])));
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_visible_card_count_check CHECK ((visible_card_count >= 0));
ALTER TABLE deal_actual_outcomes ADD CONSTRAINT deal_actual_outcomes_outcome_type_check CHECK ((outcome_type = ANY (ARRAY['RESALE'::text, 'RENOVATION'::text, 'HOLDING'::text, 'PROFIT'::text, 'RISK_MISS'::text, 'OTHER'::text])));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100)));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_conflicts_with_check CHECK ((jsonb_typeof(conflicts_with) = 'array'::text));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_director_who_requested_check CHECK ((director_who_requested = ANY (ARRAY['SCOUT'::text, 'VERIFY'::text, 'MARKET'::text, 'UNDERWRITER'::text, 'CEO'::text])));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_evidence_type_check CHECK ((evidence_type = ANY (ARRAY['LISTING_OBSERVATION'::text, 'PRICE_OBSERVATION'::text, 'DOCUMENT_OBSERVATION'::text, 'USER_INSPECTION'::text, 'MANUAL_INPUT'::text, 'AI_EXTRACTION'::text, 'VISION_OBSERVATION'::text, 'MARKET_COMPARABLE'::text, 'MARKET_TRANSACTION'::text, 'RENOVATION_QUOTE'::text, 'ACTUAL_OUTCOME'::text])));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_reliability_check CHECK (((reliability >= 0) AND (reliability <= 100)));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_source_name_check CHECK (((char_length(source_name) >= 1) AND (char_length(source_name) <= 160)));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_source_type_check CHECK ((source_type = ANY (ARRAY['OFFICIAL_PRIMARY'::text, 'VERIFIED_STRUCTURED_DATA'::text, 'DIRECT_OBSERVATION'::text, 'MULTIPLE_INDEPENDENT_SOURCES'::text, 'REPUTABLE_SECONDARY'::text, 'USER_PROVIDED'::text, 'AI_INFERENCE'::text, 'UNKNOWN'::text])));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_type_check CHECK ((type = ANY (ARRAY['FACT'::text, 'ASSUMPTION'::text, 'ESTIMATE'::text, 'PREDICTION'::text, 'USER_OVERRIDE'::text, 'UNKNOWN'::text])));
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_verification_status_check CHECK ((verification_status = ANY (ARRAY['VERIFIED'::text, 'UNVERIFIED'::text, 'CONFLICT'::text, 'STALE'::text])));
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_field_check CHECK (((char_length(field) >= 1) AND (char_length(field) <= 120)));
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 500)));
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_user_id_check CHECK (((char_length(user_id) >= 1) AND (char_length(user_id) <= 200)));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_confirmation CHECK (((confirmed_at IS NULL) OR ((confirmation_reason IS NOT NULL) AND (char_length(confirmation_reason) > 0))));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_conflict_status_check CHECK ((conflict_status = ANY (ARRAY['NONE'::text, 'CRITICAL'::text])));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_content_hash_check CHECK (((char_length(content_hash) >= 1) AND (char_length(content_hash) <= 200)));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_field_check CHECK (((char_length(field) >= 1) AND (char_length(field) <= 120)));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_source_evidence_ids_check CHECK ((jsonb_typeof(source_evidence_ids) = 'array'::text));
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_user_id_check CHECK (((char_length(user_id) >= 1) AND (char_length(user_id) <= 200)));
ALTER TABLE deal_fact_overrides ADD CONSTRAINT deal_fact_overrides_values_check CHECK ((jsonb_typeof("values") = 'object'::text));
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_actual_duration_days_check CHECK (((actual_duration_days IS NULL) OR (actual_duration_days >= 0)));
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_actual_renovation_cost_check CHECK (((actual_renovation_cost IS NULL) OR (actual_renovation_cost >= (0)::numeric)));
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_actual_resale_value_check CHECK (((actual_resale_value IS NULL) OR (actual_resale_value >= (0)::numeric)));
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_risk_misses_check CHECK ((jsonb_typeof(risk_misses) = 'array'::text));
ALTER TABLE deals ADD CONSTRAINT deals_analysis_level_check CHECK (((analysis_level >= 0) AND (analysis_level <= 3)));
ALTER TABLE deals ADD CONSTRAINT deals_ceo_check CHECK ((jsonb_typeof(ceo) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_evidence_fabric_check CHECK ((jsonb_typeof(evidence_fabric) = 'array'::text));
ALTER TABLE deals ADD CONSTRAINT deals_facts_check CHECK ((jsonb_typeof(facts) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_information_requests_check CHECK ((jsonb_typeof(information_requests) = 'array'::text));
ALTER TABLE deals ADD CONSTRAINT deals_market_check CHECK ((jsonb_typeof(market) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_playbook_check CHECK ((jsonb_typeof(playbook) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_scout_check CHECK ((jsonb_typeof(scout) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_stage_check CHECK ((stage = ANY (ARRAY['DISCOVERED'::text, 'VERIFYING'::text, 'VERIFIED'::text, 'MARKET_READY'::text, 'UNDERWRITTEN'::text, 'DECISION_READY'::text, 'ACQUISITION'::text, 'RENOVATION'::text, 'SALE'::text, 'CLOSED'::text])));
ALTER TABLE deals ADD CONSTRAINT deals_underwriting_check CHECK ((jsonb_typeof(underwriting) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_verify_check CHECK ((jsonb_typeof(verify) = 'object'::text));
ALTER TABLE deals ADD CONSTRAINT deals_version_check CHECK ((version > 0));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_decision_impact_check CHECK ((jsonb_typeof(decision_impact) = 'array'::text));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_evidence_needed_check CHECK (((char_length(evidence_needed) >= 1) AND (char_length(evidence_needed) <= 500)));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text])));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_question_check CHECK (((char_length(question) >= 1) AND (char_length(question) <= 500)));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_requested_by_check CHECK ((requested_by = ANY (ARRAY['SCOUT'::text, 'VERIFY'::text, 'MARKET'::text, 'UNDERWRITER'::text, 'CEO'::text, 'RISK'::text, 'LEGAL'::text])));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text, 'DISMISSED'::text])));
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_value_of_information_check CHECK (((value_of_information >= 0) AND (value_of_information <= 100)));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_confidence_data_check CHECK (((confidence_data IS NULL) OR ((confidence_data >= (0)::numeric) AND (confidence_data <= (100)::numeric))));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_confidence_market_check CHECK (((confidence_market IS NULL) OR ((confidence_market >= (0)::numeric) AND (confidence_market <= (100)::numeric))));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_confidence_method_check CHECK (((confidence_method IS NULL) OR ((confidence_method >= (0)::numeric) AND (confidence_method <= (100)::numeric))));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_conflicts_check CHECK ((jsonb_typeof(conflicts) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_decision_triggers_check CHECK ((jsonb_typeof(decision_triggers) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_director_check CHECK ((director = ANY (ARRAY['VERIFY'::text, 'MARKET'::text, 'RISK'::text, 'RENOVATION'::text, 'UNDERWRITER'::text, 'CFO'::text, 'ACQUISITION'::text])));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_director_version_check CHECK ((director_version > 0));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_evidence_ids_check CHECK ((jsonb_typeof(evidence_ids) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_missing_fields_check CHECK ((jsonb_typeof(missing_fields) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_next_best_actions_check CHECK ((jsonb_typeof(next_best_actions) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_reason_codes_check CHECK ((jsonb_typeof(reason_codes) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_warnings_check CHECK ((jsonb_typeof(warnings) = 'array'::text));
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_what_would_change_my_mind_check CHECK ((jsonb_typeof(what_would_change_my_mind) = 'array'::text));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_attempt_check CHECK ((attempt > 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100)));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_conflict_count_check CHECK ((conflict_count >= 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_director_check CHECK ((director = ANY (ARRAY['SCOUT'::text, 'VERIFY'::text, 'MARKET'::text, 'RISK'::text, 'RENOVATION'::text, 'UNDERWRITER'::text, 'CFO'::text, 'ACQUISITION'::text, 'CEO'::text])));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_director_version_check CHECK ((director_version > 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_elapsed_ms_check CHECK ((elapsed_ms >= 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_evidence_count_check CHECK ((evidence_count >= 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_output_check CHECK ((jsonb_typeof(output) = 'object'::text));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_output_version_check CHECK ((output_version > 0));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_status_check CHECK ((status = ANY (ARRAY['NOT_RUN'::text, 'READY'::text, 'QUEUED'::text, 'RUNNING'::text, 'COMPLETE'::text, 'STALE'::text, 'BLOCKED'::text, 'FAILED'::text])));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_tools_failed_check CHECK ((jsonb_typeof(tools_failed) = 'array'::text));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_tools_requested_check CHECK ((jsonb_typeof(tools_requested) = 'array'::text));
ALTER TABLE director_runs ADD CONSTRAINT director_runs_tools_succeeded_check CHECK ((jsonb_typeof(tools_succeeded) = 'array'::text));
ALTER TABLE director_scorecards ADD CONSTRAINT director_scorecards_critical_misses_check CHECK ((critical_misses >= 0));
ALTER TABLE director_scorecards ADD CONSTRAINT director_scorecards_deal_count_check CHECK ((deal_count >= 0));
ALTER TABLE director_scorecards ADD CONSTRAINT director_scorecards_director_check CHECK ((director = ANY (ARRAY['SCOUT'::text, 'VERIFY'::text, 'MARKET'::text, 'UNDERWRITER'::text, 'CEO'::text, 'RISK'::text, 'LEGAL'::text])));
ALTER TABLE director_scorecards ADD CONSTRAINT director_scorecards_metrics_check CHECK ((jsonb_typeof(metrics) = 'object'::text));
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_distinct CHECK ((left_evidence_id <> right_evidence_id));
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_field_check CHECK (((char_length(field) >= 1) AND (char_length(field) <= 120)));
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text])));
ALTER TABLE facebook_group_discovery_sessions ADD CONSTRAINT facebook_group_discovery_sessions_candidates_bounded CHECK (((jsonb_typeof(candidates) = 'array'::text) AND (jsonb_array_length(candidates) <= 200)));
ALTER TABLE facebook_group_discovery_sessions ADD CONSTRAINT facebook_group_discovery_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_attempts_check CHECK ((attempts >= 0));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_consumer_type_check CHECK ((consumer_type = ANY (ARRAY['BROWSER_EXTENSION'::text, 'LEGACY_WORKER'::text])));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_group_snapshot_check CHECK (((jsonb_typeof(group_snapshot) = 'array'::text) AND (jsonb_array_length(group_snapshot) <= 1)));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['SOURCE_SCAN'::text, 'GALLERY_HYDRATION'::text])));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_max_attempts_check CHECK ((max_attempts > 0));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_priority_nonnegative CHECK ((priority >= 0));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_result_summary_check CHECK (((result_summary IS NULL) OR (jsonb_typeof(result_summary) = 'object'::text)));
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])));
ALTER TABLE finder_building_type_confirmations ADD CONSTRAINT finder_building_type_confirmations_building_type_check CHECK ((building_type = ANY (ARRAY['blok'::text, 'apartamentowiec'::text, 'kamienica'::text, 'dom'::text, 'loft'::text, 'plomba'::text])));
ALTER TABLE finder_building_type_confirmations ADD CONSTRAINT finder_building_type_confirmations_note_check CHECK (((note IS NULL) OR (char_length(note) <= 500)));
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_check CHECK ((listing_a < listing_b));
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_decision_check CHECK ((decision = ANY (ARRAY['link'::text, 'not_link'::text])));
ALTER TABLE finder_olx_slots ADD CONSTRAINT finder_olx_slots_details_check CHECK ((jsonb_typeof(details) = 'object'::text));
ALTER TABLE finder_olx_slots ADD CONSTRAINT finder_olx_slots_status_check CHECK ((status = ANY (ARRAY['enqueued'::text, 'missed'::text])));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_action_stage_check CHECK (((action_stage IS NULL) OR ((char_length(action_stage) >= 1) AND (char_length(action_stage) <= 60))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_client_build_check CHECK (((client_build IS NULL) OR ((char_length(client_build) >= 1) AND (char_length(client_build) <= 120))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_component_check CHECK (((component IS NULL) OR (component = 'GalleryRequestButton'::text)));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_error_message_check CHECK (((error_message IS NULL) OR ((char_length(error_message) >= 1) AND (char_length(error_message) <= 160))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_error_name_check CHECK (((error_name IS NULL) OR ((char_length(error_name) >= 1) AND (char_length(error_name) <= 60))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_event_check CHECK ((event = ANY (ARRAY['GALLERY_BUTTON_RENDERED'::text, 'GALLERY_BUTTON_MOUNT'::text, 'GALLERY_BUTTON_UNMOUNT'::text, 'GALLERY_NATIVE_POINTER_CAPTURE'::text, 'GALLERY_NATIVE_CLICK_CAPTURE'::text, 'GALLERY_CLIENT_EXCEPTION'::text, 'GALLERY_CARD_POINTER_CAPTURE'::text, 'GALLERY_BUTTON_POINTER_CAPTURE'::text, 'GALLERY_CARD_CLICK_CAPTURE'::text, 'GALLERY_BUTTON_CLICK_CAPTURE'::text, 'GALLERY_UI_CLICK'::text, 'GALLERY_HANDLER_ENTER'::text, 'GALLERY_GUARD_PASS'::text, 'GALLERY_GUARD_BLOCKED'::text, 'GALLERY_FETCH_START'::text, 'GALLERY_FETCH_RESPONSE'::text, 'GALLERY_FETCH_ERROR'::text])));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_gallery_status_check CHECK ((gallery_status = ANY (ARRAY['NOT_REQUESTED'::text, 'PENDING'::text, 'RUNNING'::text, 'PARTIAL'::text, 'COMPLETE'::text, 'FAILED'::text])));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_http_status_check CHECK (((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_instance_id_check CHECK (((instance_id IS NULL) OR ((char_length(instance_id) >= 8) AND (char_length(instance_id) <= 80))));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_post_id_check CHECK (((post_id IS NULL) OR (post_id ~ '^[0-9]{5,30}$'::text)));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_source_check CHECK (((source IS NULL) OR (source = 'facebook'::text)));
ALTER TABLE gallery_request_traces ADD CONSTRAINT gallery_request_traces_trace_id_check CHECK ((trace_id ~ '^[A-Za-z0-9-]{8,80}$'::text));
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_content_hash_check CHECK (((char_length(content_hash) >= 1) AND (char_length(content_hash) <= 200)));
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_field_check CHECK (((char_length(field) >= 1) AND (char_length(field) <= 120)));
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_provenance_check CHECK ((provenance = ANY (ARRAY['FACT'::text, 'EXTRACTED'::text, 'DERIVED'::text, 'USER_ASSUMPTION'::text, 'MARKET_ASSUMPTION'::text, 'MANUAL_OVERRIDE'::text, 'AI_INFERENCE'::text, 'ESTIMATE'::text, 'UNKNOWN'::text])));
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_valid_window CHECK (((valid_until IS NULL) OR (valid_from IS NULL) OR (valid_until >= valid_from)));
ALTER TABLE listing_filter_match_audit ADD CONSTRAINT listing_filter_match_audit_new_state_check CHECK ((new_state = ANY (ARRAY['MATCHED'::text, 'REVIEW'::text, 'INACTIVE'::text, 'NONE'::text])));
ALTER TABLE listing_filter_match_audit ADD CONSTRAINT listing_filter_match_audit_previous_state_check CHECK ((previous_state = ANY (ARRAY['MATCHED'::text, 'REVIEW'::text, 'INACTIVE'::text, 'NONE'::text])));
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_match_origin_check CHECK ((match_origin = ANY (ARRAY['scan'::text, 'filter_recalculation'::text, 'collector_import'::text])));
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_reasons_array CHECK ((jsonb_typeof(match_reasons) = 'array'::text));
ALTER TABLE listing_snapshots ADD CONSTRAINT listing_snapshots_price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric)));
ALTER TABLE listing_snapshots ADD CONSTRAINT listing_snapshots_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text, 'sold'::text, 'watched'::text])));
ALTER TABLE listing_source_metadata ADD CONSTRAINT listing_source_metadata_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE listing_source_metadata ADD CONSTRAINT listing_source_metadata_source_check CHECK ((source = 'facebook'::text));
ALTER TABLE listings ADD CONSTRAINT listings_area_positive CHECK (((area IS NULL) OR (area > (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_cross_source_identity_format_check CHECK (((cross_source_identity IS NULL) OR (cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'::text)));
ALTER TABLE listings ADD CONSTRAINT listings_estimated_renovation_cost_nonnegative CHECK (((estimated_renovation_cost IS NULL) OR (estimated_renovation_cost >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_estimated_roi_nonnegative CHECK (((estimated_roi IS NULL) OR (estimated_roi >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_estimated_sale_price_nonnegative CHECK (((estimated_sale_price IS NULL) OR (estimated_sale_price >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_gallery_counts_nonnegative CHECK (((gallery_total >= 0) AND (gallery_persisted_count >= 0)));
ALTER TABLE listings ADD CONSTRAINT listings_gallery_status_check CHECK ((gallery_status = ANY (ARRAY['NOT_REQUESTED'::text, 'PENDING'::text, 'RUNNING'::text, 'PARTIAL'::text, 'COMPLETE'::text, 'FAILED'::text])));
ALTER TABLE listings ADD CONSTRAINT listings_identity_evidence_object_check CHECK (((identity_evidence IS NULL) OR (jsonb_typeof(identity_evidence) = 'object'::text)));
ALTER TABLE listings ADD CONSTRAINT listings_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['ACTIVE'::text, 'REVIEW'::text, 'STALE'::text, 'ARCHIVED'::text, 'REJECTED'::text])));
ALTER TABLE listings ADD CONSTRAINT listings_manual_decision_check CHECK (((manual_decision IS NULL) OR (manual_decision = ANY (ARRAY['ACCEPTED'::text, 'REJECTED'::text]))));
ALTER TABLE listings ADD CONSTRAINT listings_missing_fields_array_check CHECK ((jsonb_typeof(missing_fields) = 'array'::text));
ALTER TABLE listings ADD CONSTRAINT listings_price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_price_per_sqm_nonnegative CHECK (((price_per_sqm IS NULL) OR (price_per_sqm >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_rent_nonnegative CHECK (((rent IS NULL) OR (rent >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_rooms_nonnegative CHECK (((rooms IS NULL) OR (rooms >= (0)::numeric)));
ALTER TABLE listings ADD CONSTRAINT listings_source_check CHECK ((source = ANY (ARRAY['otodom'::text, 'olx'::text, 'morizon'::text, 'facebook'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'oferty_net'::text, 'szybko'::text, 'bezposrednio'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text, 'official_auction'::text])));
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text, 'sold'::text, 'watched'::text])));
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_area_range CHECK (((area_min IS NULL) OR (area_max IS NULL) OR (area_min <= area_max)));
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100)));
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_prices_ordered CHECK (((resale_price_per_m2_low <= resale_price_per_m2_base) AND (resale_price_per_m2_base <= resale_price_per_m2_high)));
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_prices_positive CHECK (((resale_price_per_m2_low > (0)::numeric) AND (resale_price_per_m2_base > (0)::numeric) AND (resale_price_per_m2_high > (0)::numeric)));
ALTER TABLE market_assumptions ADD CONSTRAINT market_assumptions_provenance_check CHECK ((provenance = ANY (ARRAY['USER_ASSUMPTION'::text, 'MARKET_ASSUMPTION'::text])));
ALTER TABLE olx_automation_control ADD CONSTRAINT olx_automation_control_id_check CHECK ((id = 1));
ALTER TABLE olx_automation_control ADD CONSTRAINT olx_automation_control_max_claims_24h_check CHECK (((max_claims_24h >= 0) AND (max_claims_24h <= 2)));
ALTER TABLE olx_automation_control ADD CONSTRAINT olx_automation_control_unclaimed_expiry_minutes_check CHECK (((unclaimed_expiry_minutes >= 30) AND (unclaimed_expiry_minutes <= 1440)));
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_account_browser_ms_check CHECK ((account_browser_ms >= 0));
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_job_estimate_ms_check CHECK (((job_estimate_ms >= 0) AND (job_estimate_ms <= 600000)));
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_safe_budget_ms_check CHECK (((safe_budget_ms >= 0) AND (safe_budget_ms <= 600000)));
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_worker_browser_ms_check CHECK ((worker_browser_ms >= 0));
ALTER TABLE olx_cloud_budget ADD CONSTRAINT olx_cloud_budget_worker_id_check CHECK (((length(worker_id) >= 3) AND (length(worker_id) <= 100)));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_attempts_check CHECK ((attempts >= 0));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_context_check CHECK ((((context_type = 'finder'::text) AND (source_scan_id IS NOT NULL) AND (search_filter_id IS NOT NULL) AND (radar_owner_id IS NULL) AND (radar_run_id IS NULL) AND (radar_lease_token IS NULL)) OR ((context_type = 'price_radar'::text) AND (source_scan_id IS NULL) AND (search_filter_id IS NULL) AND (radar_owner_id IS NOT NULL) AND (radar_run_id IS NOT NULL) AND (radar_lease_token IS NOT NULL) AND (scan_run_id = radar_run_id))));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_filter_snapshot_object CHECK ((jsonb_typeof(filter_snapshot) = 'object'::text));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_max_attempts_check CHECK ((max_attempts > 0));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_request_url_check CHECK ((request_url ~ '^https://(www\.)?olx\.pl/'::text));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_requested_by_check CHECK (((requested_by IS NULL) OR (requested_by = ANY (ARRAY['scheduler'::text, 'manual'::text]))));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_result_summary_object CHECK (((result_summary IS NULL) OR (jsonb_typeof(result_summary) = 'object'::text)));
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_area_check CHECK ((area > (0)::numeric));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_assigned_district_check CHECK (((assigned_district IS NULL) OR (assigned_district = ANY (ARRAY['Bałuty'::text, 'Górna'::text, 'Polesie'::text, 'Śródmieście'::text, 'Widzew'::text]))));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_building_type_check CHECK ((building_type = ANY (ARRAY['blok'::text, 'apartamentowiec'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_market_type_check CHECK ((market_type = ANY (ARRAY['primary'::text, 'secondary'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_price_check CHECK ((price > (0)::numeric));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_price_per_sqm_check CHECK ((price_per_sqm > (0)::numeric));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_renovation_status_check CHECK ((renovation_status = ANY (ARRAY['fresh_renovation'::text, 'turnkey_finish'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_source_check CHECK ((source = ANY (ARRAY['otodom'::text, 'olx'::text, 'morizon'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'oferty_net'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'assigned'::text, 'rejected'::text])));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_suggested_district_check CHECK (((suggested_district IS NULL) OR (suggested_district = ANY (ARRAY['Bałuty'::text, 'Górna'::text, 'Polesie'::text, 'Śródmieście'::text, 'Widzew'::text]))));
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_suggestion_source_check CHECK (((suggestion_source IS NULL) OR (suggestion_source = ANY (ARRAY['gis'::text, 'ai'::text]))));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_area_check CHECK ((area > (0)::numeric));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_building_type_check CHECK ((building_type = ANY (ARRAY['blok'::text, 'apartamentowiec'::text])));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_cross_source_identity_format_check CHECK (((cross_source_identity IS NULL) OR (cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'::text)));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_market_type_check CHECK ((market_type = ANY (ARRAY['primary'::text, 'secondary'::text])));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_price_check CHECK ((price > (0)::numeric));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_price_per_sqm_check CHECK ((price_per_sqm > (0)::numeric));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_renovation_status_check CHECK ((renovation_status = ANY (ARRAY['fresh_renovation'::text, 'turnkey_finish'::text])));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_source_check CHECK ((source = ANY (ARRAY['otodom'::text, 'olx'::text, 'morizon'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'oferty_net'::text, 'szybko'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text])));
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])));
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_checkpoint_check CHECK ((jsonb_typeof(checkpoint) = 'object'::text));
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_qualified_count_check CHECK ((qualified_count >= 0));
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_scanned_count_check CHECK ((scanned_count >= 0));
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_source_statuses_check CHECK ((jsonb_typeof(source_statuses) = 'object'::text));
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'partial'::text])));
ALTER TABLE price_radar_settings ADD CONSTRAINT price_radar_settings_filters_check CHECK ((jsonb_typeof(filters) = 'object'::text));
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_field_evidence_check CHECK ((jsonb_typeof(field_evidence) = 'object'::text));
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_operator_decision_check CHECK (((operator_decision IS NULL) OR (jsonb_typeof(operator_decision) = 'object'::text)));
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_source_check CHECK ((source = ANY (ARRAY['otodom'::text, 'olx'::text, 'morizon'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'oferty_net'::text, 'szybko'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text])));
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_source_snapshot_check CHECK ((jsonb_typeof(source_snapshot) = 'object'::text));
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])));
ALTER TABLE properties ADD CONSTRAINT properties_comparable_count_nonnegative CHECK (((comparable_count IS NULL) OR (comparable_count >= 0)));
ALTER TABLE properties ADD CONSTRAINT properties_cross_source_identity_format_check CHECK (((cross_source_identity IS NULL) OR (cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'::text)));
ALTER TABLE properties ADD CONSTRAINT properties_purchase_decision_check CHECK (((purchase_decision IS NULL) OR (purchase_decision = ANY (ARRAY['buy'::text, 'negotiate'::text, 'reject'::text]))));
ALTER TABLE resale_comp_price_history ADD CONSTRAINT resale_comp_price_history_price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric)));
ALTER TABLE resale_comp_price_history ADD CONSTRAINT resale_comp_price_history_price_per_m2_nonnegative CHECK (((price_per_m2 IS NULL) OR (price_per_m2 >= (0)::numeric)));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_area_positive CHECK (((area_m2 IS NULL) OR (area_m2 > (0)::numeric)));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_price_nonnegative CHECK (((price IS NULL) OR (price >= (0)::numeric)));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_price_per_m2_nonnegative CHECK (((price_per_m2 IS NULL) OR (price_per_m2 >= (0)::numeric)));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_renovation_confidence_check CHECK ((renovation_confidence = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text, 'LOW'::text])));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_renovation_status_check CHECK ((renovation_status = ANY (ARRAY['RENOVATED'::text, 'MOVE_IN_READY'::text, 'REFRESHED'::text, 'UNKNOWN'::text])));
ALTER TABLE resale_comps ADD CONSTRAINT resale_comps_source_check CHECK ((source = ANY (ARRAY['facebook'::text, 'otodom'::text, 'olx'::text, 'morizon'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'oferty_net'::text, 'szybko'::text, 'bezposrednio'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text, 'official_auction'::text])));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_area_max_nonnegative CHECK (((area_max IS NULL) OR (area_max >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_area_min_nonnegative CHECK (((area_min IS NULL) OR (area_min >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_area_range CHECK (((area_min IS NULL) OR (area_max IS NULL) OR (area_min <= area_max)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_building_types_array CHECK ((jsonb_typeof(building_types) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_districts_array CHECK ((jsonb_typeof(districts) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_excluded_keywords_array CHECK ((jsonb_typeof(excluded_keywords) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_finder_olx_scan_interval_allowed CHECK ((finder_olx_scan_interval_minutes = ANY (ARRAY[720, 1440, 2880, 4320])));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_finder_olx_start_time_step CHECK (((EXTRACT(second FROM finder_olx_start_time) = (0)::numeric) AND (((EXTRACT(minute FROM finder_olx_start_time))::integer % 5) = 0)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_finder_scan_interval_positive CHECK ((finder_scan_interval_minutes > 0));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_floor_range CHECK (((floor_min IS NULL) OR (floor_max IS NULL) OR (floor_min <= floor_max)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_market_type_check CHECK ((market_type = ANY (ARRAY['primary'::text, 'secondary'::text])));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_max_estimated_renovation_cost_nonnegative CHECK (((max_estimated_renovation_cost IS NULL) OR (max_estimated_renovation_cost >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_max_price_per_sqm_nonnegative CHECK (((max_price_per_sqm IS NULL) OR (max_price_per_sqm >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_min_estimated_profit_nonnegative CHECK (((min_estimated_profit IS NULL) OR (min_estimated_profit >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_ownership_types_array CHECK ((jsonb_typeof(ownership_types) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_price_max_nonnegative CHECK (((price_max IS NULL) OR (price_max >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_price_min_nonnegative CHECK (((price_min IS NULL) OR (price_min >= (0)::numeric)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_price_range CHECK (((price_min IS NULL) OR (price_max IS NULL) OR (price_min <= price_max)));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_required_keywords_array CHECK ((jsonb_typeof(required_keywords) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_rooms_array CHECK ((jsonb_typeof(rooms) = 'array'::text));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_scan_interval_positive CHECK ((scan_interval_minutes > 0));
ALTER TABLE search_filters ADD CONSTRAINT search_filters_sources_array CHECK ((jsonb_typeof(sources) = 'array'::text));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_continuation_attempt_check CHECK ((continuation_attempt >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_diagnostics_array CHECK ((jsonb_typeof(diagnostics) = 'array'::text));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_filter_snapshot_object CHECK ((jsonb_typeof(filter_snapshot) = 'object'::text));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_finished_after_started CHECK (((finished_at IS NULL) OR (finished_at >= started_at)));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_listings_created_check CHECK ((listings_created >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_listings_found_check CHECK ((listings_found >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_listings_updated_check CHECK ((listings_updated >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_matched_count_check CHECK ((matched_count >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_new_count_check CHECK ((new_count >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_price_drop_count_check CHECK ((price_drop_count >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_scanned_count_check CHECK ((scanned_count >= 0));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_source_check CHECK ((source = ANY (ARRAY['otodom'::text, 'olx'::text, 'morizon'::text, 'facebook'::text, 'gratka'::text, 'nieruchomosci_online'::text, 'domiporta'::text, 'sprzedajemy'::text, 'adresowo'::text, 'oferty_net'::text, 'szybko'::text, 'bezposrednio'::text, 'domy'::text, 'allegro_lokalnie'::text, 'official_cooperative'::text, 'official_uml'::text, 'official_auction'::text])));
ALTER TABLE source_scans ADD CONSTRAINT source_scans_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'partial'::text])));
ALTER TABLE underwriting_settings ADD CONSTRAINT underwriting_settings_id_check CHECK ((id = 'default'::text));
ALTER TABLE underwriting_settings ADD CONSTRAINT underwriting_settings_values_check CHECK ((jsonb_typeof("values") = 'object'::text));
ALTER TABLE underwriting_settings ADD CONSTRAINT underwriting_settings_version_check CHECK ((version > 0));
ALTER TABLE watched_facebook_groups ADD CONSTRAINT watched_facebook_groups_access_status_check CHECK ((access_status = ANY (ARRAY['CONNECTED'::text, 'MANUAL_IMPORT'::text, 'AUTH_REQUIRED'::text, 'UNAVAILABLE'::text])));
ALTER TABLE watched_facebook_groups ADD CONSTRAINT watched_facebook_groups_priority_check CHECK ((priority = ANY (ARRAY['high'::text, 'normal'::text, 'low'::text])));
ALTER TABLE watched_facebook_groups ADD CONSTRAINT watched_facebook_groups_url_check CHECK ((url ~ '^https://([^/]+\.)?facebook\.com/'::text));
ALTER TABLE alerts ADD CONSTRAINT alerts_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE ceo_decisions ADD CONSTRAINT ceo_decisions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_device_id_fkey FOREIGN KEY (device_id) REFERENCES collector_devices(id) ON DELETE CASCADE;
ALTER TABLE collector_imports ADD CONSTRAINT collector_imports_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
ALTER TABLE collector_request_nonces ADD CONSTRAINT collector_request_nonces_device_id_fkey FOREIGN KEY (device_id) REFERENCES collector_devices(id) ON DELETE CASCADE;
ALTER TABLE collector_scan_batches ADD CONSTRAINT collector_scan_batches_device_id_fkey FOREIGN KEY (device_id) REFERENCES collector_devices(id) ON DELETE CASCADE;
ALTER TABLE deal_actual_outcomes ADD CONSTRAINT deal_actual_outcomes_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deal_actual_outcomes ADD CONSTRAINT deal_actual_outcomes_source_evidence_id_fkey FOREIGN KEY (source_evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deal_evidence ADD CONSTRAINT deal_evidence_supersedes_evidence_id_fkey FOREIGN KEY (supersedes_evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deal_fact_override_confirmations ADD CONSTRAINT deal_fact_override_confirmations_override_event_id_fkey FOREIGN KEY (override_event_id) REFERENCES deal_fact_override_events(id) ON DELETE CASCADE;
ALTER TABLE deal_fact_override_events ADD CONSTRAINT deal_fact_override_events_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deal_fact_overrides ADD CONSTRAINT deal_fact_overrides_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deal_outcomes ADD CONSTRAINT deal_outcomes_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE deals ADD CONSTRAINT deals_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE director_information_requests ADD CONSTRAINT director_information_requests_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE director_outputs ADD CONSTRAINT director_outputs_run_id_fkey FOREIGN KEY (run_id) REFERENCES director_runs(id) ON DELETE CASCADE;
ALTER TABLE director_runs ADD CONSTRAINT director_runs_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_left_evidence_id_fkey FOREIGN KEY (left_evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_resolution_evidence_id_fkey FOREIGN KEY (resolution_evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE evidence_conflicts ADD CONSTRAINT evidence_conflicts_right_evidence_id_fkey FOREIGN KEY (right_evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE facebook_group_discovery_sessions ADD CONSTRAINT facebook_group_discovery_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES collector_devices(id) ON DELETE SET NULL;
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_gallery_listing_id_fkey FOREIGN KEY (gallery_listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE facebook_scan_jobs ADD CONSTRAINT facebook_scan_jobs_source_scan_id_fkey FOREIGN KEY (source_scan_id) REFERENCES source_scans(id) ON DELETE CASCADE;
ALTER TABLE finder_building_type_confirmations ADD CONSTRAINT finder_building_type_confirmations_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_listing_a_fkey FOREIGN KEY (listing_a) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_listing_b_fkey FOREIGN KEY (listing_b) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE finder_listing_identity_decisions ADD CONSTRAINT finder_listing_identity_decisions_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE finder_listing_identity_groups ADD CONSTRAINT finder_listing_identity_groups_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE finder_listing_identity_groups ADD CONSTRAINT finder_listing_identity_groups_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE finder_olx_slots ADD CONSTRAINT finder_olx_slots_job_id_fkey FOREIGN KEY (job_id) REFERENCES olx_scan_jobs(id) ON DELETE SET NULL;
ALTER TABLE finder_olx_slots ADD CONSTRAINT finder_olx_slots_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES deal_evidence(id);
ALTER TABLE listing_fact_observations ADD CONSTRAINT listing_fact_observations_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE listing_filter_match_audit ADD CONSTRAINT listing_filter_match_audit_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE listing_filter_match_audit ADD CONSTRAINT listing_filter_match_audit_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE listing_filter_matches ADD CONSTRAINT listing_filter_matches_source_scan_id_fkey FOREIGN KEY (source_scan_id) REFERENCES source_scans(id) ON DELETE SET NULL;
ALTER TABLE listing_snapshots ADD CONSTRAINT listing_snapshots_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE listing_source_metadata ADD CONSTRAINT listing_source_metadata_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE;
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_radar_owner_id_fkey FOREIGN KEY (radar_owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_radar_run_id_fkey FOREIGN KEY (radar_run_id) REFERENCES price_radar_runs(id) ON DELETE CASCADE;
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
ALTER TABLE olx_scan_jobs ADD CONSTRAINT olx_scan_jobs_source_scan_id_fkey FOREIGN KEY (source_scan_id) REFERENCES source_scans(id) ON DELETE CASCADE;
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_district_queue ADD CONSTRAINT price_radar_district_queue_radar_listing_id_fkey FOREIGN KEY (radar_listing_id) REFERENCES price_radar_listings(id) ON DELETE SET NULL;
ALTER TABLE price_radar_listings ADD CONSTRAINT price_radar_listings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_runs ADD CONSTRAINT price_radar_runs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_settings ADD CONSTRAINT price_radar_settings_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_decision_by_fkey FOREIGN KEY (decision_by) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE price_radar_verification_queue ADD CONSTRAINT price_radar_verification_queue_radar_listing_id_fkey FOREIGN KEY (radar_listing_id) REFERENCES price_radar_listings(id) ON DELETE SET NULL;
ALTER TABLE properties ADD CONSTRAINT properties_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL;
ALTER TABLE resale_comp_price_history ADD CONSTRAINT resale_comp_price_history_comp_id_fkey FOREIGN KEY (comp_id) REFERENCES resale_comps(id) ON DELETE CASCADE;
ALTER TABLE source_scans ADD CONSTRAINT source_scans_search_filter_id_fkey FOREIGN KEY (search_filter_id) REFERENCES search_filters(id) ON DELETE CASCADE;
CREATE INDEX alerts_listing_idx ON public.alerts USING btree (listing_id, detected_at DESC);
CREATE INDEX alerts_read_detected_idx ON public.alerts USING btree (read_at, detected_at DESC);
CREATE INDEX ceo_decisions_deal_idx ON public.ceo_decisions USING btree (deal_id, created_at DESC);
CREATE INDEX ceo_decisions_fingerprint_idx ON public.ceo_decisions USING btree (input_fingerprint);
CREATE INDEX collector_imports_device_created_at_idx ON public.collector_imports USING btree (device_id, created_at DESC);
CREATE INDEX collector_request_nonces_expires_at_idx ON public.collector_request_nonces USING btree (expires_at);
CREATE INDEX collector_scan_batches_device_received_idx ON public.collector_scan_batches USING btree (device_id, received_at DESC);
CREATE INDEX collector_scan_batches_scan_source_idx ON public.collector_scan_batches USING btree (scan_id, source_id);
CREATE INDEX deal_actual_outcomes_deal_idx ON public.deal_actual_outcomes USING btree (deal_id, observed_at DESC);
CREATE INDEX deal_evidence_deal_observed_idx ON public.deal_evidence USING btree (deal_id, observed_at DESC);
CREATE INDEX deal_fact_override_confirmations_deal_idx ON public.deal_fact_override_confirmations USING btree (deal_id, confirmed_at DESC);
CREATE INDEX deal_fact_override_events_deal_idx ON public.deal_fact_override_events USING btree (deal_id, created_at DESC);
CREATE INDEX deals_stage_updated_at_idx ON public.deals USING btree (stage, updated_at DESC);
CREATE INDEX director_information_requests_deal_priority_idx ON public.director_information_requests USING btree (deal_id, value_of_information DESC) WHERE (status = 'OPEN'::text);
CREATE INDEX director_outputs_deal_idx ON public.director_outputs USING btree (deal_id, computed_at DESC);
CREATE INDEX director_outputs_director_idx ON public.director_outputs USING btree (director, computed_at DESC);
CREATE INDEX director_outputs_fingerprint_idx ON public.director_outputs USING btree (input_fingerprint);
CREATE INDEX director_runs_deal_computed_idx ON public.director_runs USING btree (deal_id, computed_at DESC);
CREATE UNIQUE INDEX director_runs_one_active_idx ON public.director_runs USING btree (deal_id, director) WHERE (status = ANY (ARRAY['READY'::text, 'QUEUED'::text, 'RUNNING'::text]));
CREATE INDEX evidence_conflicts_deal_idx ON public.evidence_conflicts USING btree (deal_id, created_at DESC);
CREATE INDEX facebook_group_discovery_sessions_expires_idx ON public.facebook_group_discovery_sessions USING btree (expires_at);
CREATE INDEX facebook_scan_jobs_claim_idx ON public.facebook_scan_jobs USING btree (status, available_at, created_at) WHERE (status = 'queued'::text);
CREATE INDEX facebook_scan_jobs_consumer_claim_idx ON public.facebook_scan_jobs USING btree (consumer_type, status, available_at, created_at) WHERE (status = 'queued'::text);
CREATE INDEX facebook_scan_jobs_consumer_priority_claim_idx ON public.facebook_scan_jobs USING btree (consumer_type, status, priority DESC, available_at, created_at) WHERE (status = 'queued'::text);
CREATE UNIQUE INDEX facebook_scan_jobs_gallery_active_unique ON public.facebook_scan_jobs USING btree (gallery_listing_id) WHERE ((job_type = 'GALLERY_HYDRATION'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])) AND (gallery_listing_id IS NOT NULL));
CREATE INDEX facebook_scan_jobs_lease_idx ON public.facebook_scan_jobs USING btree (leased_until) WHERE (status = 'running'::text);
CREATE INDEX facebook_scan_jobs_run_idx ON public.facebook_scan_jobs USING btree (scan_run_id, created_at DESC);
CREATE UNIQUE INDEX facebook_scan_jobs_source_idempotency_unique ON public.facebook_scan_jobs USING btree (idempotency_key) WHERE (job_type = 'SOURCE_SCAN'::text);
CREATE UNIQUE INDEX facebook_scan_jobs_source_scan_id_unique ON public.facebook_scan_jobs USING btree (source_scan_id) WHERE (source_scan_id IS NOT NULL);
CREATE INDEX facebook_worker_nonces_expires_at_idx ON public.facebook_worker_nonces USING btree (expires_at);
CREATE INDEX finder_listing_identity_groups_lookup_idx ON public.finder_listing_identity_groups USING btree (owner_id, search_filter_id, group_id, listing_id);
CREATE INDEX gallery_request_traces_listing_created_idx ON public.gallery_request_traces USING btree (listing_id, created_at DESC);
CREATE INDEX gallery_request_traces_trace_created_idx ON public.gallery_request_traces USING btree (trace_id, created_at);
CREATE INDEX listing_fact_observations_deal_idx ON public.listing_fact_observations USING btree (deal_id, observed_at DESC);
CREATE INDEX listing_fact_observations_listing_idx ON public.listing_fact_observations USING btree (listing_id, field, observed_at DESC);
CREATE INDEX listing_filter_match_audit_filter_created_idx ON public.listing_filter_match_audit USING btree (search_filter_id, created_at DESC);
CREATE INDEX listing_filter_match_audit_scan_run_idx ON public.listing_filter_match_audit USING btree (scan_run_id, created_at DESC) WHERE (scan_run_id IS NOT NULL);
CREATE INDEX listing_filter_matches_filter_current_last_matched_idx ON public.listing_filter_matches USING btree (search_filter_id, is_current_match, last_matched_at DESC);
CREATE INDEX listing_filter_matches_filter_origin_idx ON public.listing_filter_matches USING btree (search_filter_id, match_origin);
CREATE INDEX listing_snapshots_listing_id_captured_at_idx ON public.listing_snapshots USING btree (listing_id, captured_at DESC);
CREATE INDEX listing_source_metadata_listing_id_idx ON public.listing_source_metadata USING btree (listing_id);
CREATE INDEX listing_source_metadata_source_collected_at_idx ON public.listing_source_metadata USING btree (source, collected_at DESC);
CREATE INDEX listings_city_district_idx ON public.listings USING btree (city, district);
CREATE INDEX listings_content_hash_idx ON public.listings USING btree (content_hash) WHERE (content_hash IS NOT NULL);
CREATE INDEX listings_cross_source_identity_idx ON public.listings USING btree (cross_source_identity, source, id) WHERE (cross_source_identity IS NOT NULL);
CREATE INDEX listings_gallery_status_idx ON public.listings USING btree (gallery_status, gallery_requested_at DESC);
CREATE INDEX listings_lifecycle_status_last_seen_idx ON public.listings USING btree (lifecycle_status, last_seen_at DESC);
CREATE UNIQUE INDEX listings_normalized_url_key ON public.listings USING btree (normalized_url) WHERE (normalized_url IS NOT NULL);
CREATE INDEX listings_status_last_seen_at_idx ON public.listings USING btree (status, last_seen_at DESC);
CREATE INDEX market_assumptions_match_idx ON public.market_assumptions USING btree (city, district, building_type, rooms, active, effective_from DESC);
CREATE INDEX olx_scan_jobs_claim_idx ON public.olx_scan_jobs USING btree (status, available_at, created_at) WHERE (status = 'queued'::text);
CREATE INDEX olx_scan_jobs_created_at_idx ON public.olx_scan_jobs USING btree (created_at DESC);
CREATE INDEX olx_scan_jobs_filter_created_idx ON public.olx_scan_jobs USING btree (search_filter_id, created_at DESC) WHERE (context_type = 'finder'::text);
CREATE INDEX olx_scan_jobs_lease_idx ON public.olx_scan_jobs USING btree (leased_until) WHERE (status = 'running'::text);
CREATE INDEX olx_scan_jobs_run_idx ON public.olx_scan_jobs USING btree (scan_run_id, created_at DESC);
CREATE INDEX olx_worker_nonces_expires_at_idx ON public.olx_worker_nonces USING btree (expires_at);
CREATE INDEX price_radar_district_queue_owner_status_idx ON public.price_radar_district_queue USING btree (owner_id, status);
CREATE INDEX price_radar_listings_owner_cross_identity_idx ON public.price_radar_listings USING btree (owner_id, cross_source_identity) WHERE ((cross_source_identity IS NOT NULL) AND (status = 'active'::text));
CREATE INDEX price_radar_listings_owner_district_market_idx ON public.price_radar_listings USING btree (owner_id, district, market_type) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX price_radar_runs_one_active_per_owner_idx ON public.price_radar_runs USING btree (owner_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX price_radar_runs_owner_latest_idx ON public.price_radar_runs USING btree (owner_id, started_at DESC);
CREATE INDEX price_radar_verification_queue_owner_status_seen_idx ON public.price_radar_verification_queue USING btree (owner_id, status, last_seen_at DESC);
CREATE UNIQUE INDEX properties_cross_source_identity_key ON public.properties USING btree (cross_source_identity) WHERE (cross_source_identity IS NOT NULL);
CREATE INDEX properties_listing_id_idx ON public.properties USING btree (listing_id) WHERE (listing_id IS NOT NULL);
CREATE INDEX properties_normalized_url_idx ON public.properties USING btree (normalized_url) WHERE (normalized_url IS NOT NULL);
CREATE INDEX properties_original_url_idx ON public.properties USING btree (original_url) WHERE (original_url IS NOT NULL);
CREATE UNIQUE INDEX properties_source_external_listing_id_key ON public.properties USING btree (source, external_listing_id) WHERE ((source IS NOT NULL) AND (external_listing_id IS NOT NULL));
CREATE INDEX push_subscriptions_enabled_idx ON public.push_subscriptions USING btree (enabled) WHERE (enabled = true);
CREATE INDEX resale_comp_price_history_comp_observed_idx ON public.resale_comp_price_history USING btree (comp_id, observed_at DESC);
CREATE UNIQUE INDEX resale_comps_canonical_url_key ON public.resale_comps USING btree (canonical_url) WHERE (canonical_url IS NOT NULL);
CREATE INDEX resale_comps_confidence_active_idx ON public.resale_comps USING btree (renovation_confidence, active, last_seen_at DESC);
CREATE UNIQUE INDEX resale_comps_fingerprint_key ON public.resale_comps USING btree (fingerprint) WHERE (fingerprint IS NOT NULL);
CREATE INDEX resale_comps_location_last_seen_idx ON public.resale_comps USING btree (city, district, street, last_seen_at DESC);
CREATE UNIQUE INDEX resale_comps_source_external_id_key ON public.resale_comps USING btree (source, external_listing_id);
CREATE INDEX search_filters_active_finder_scan_interval_idx ON public.search_filters USING btree (is_active, last_scanned_at, finder_scan_interval_minutes);
CREATE INDEX search_filters_active_last_scanned_at_idx ON public.search_filters USING btree (is_active, last_scanned_at);
CREATE INDEX source_scans_continuation_due_idx ON public.source_scans USING btree (continuation_next_at, continuation_cycle_at, started_at) WHERE ((status = ANY (ARRAY['pending'::text, 'running'::text])) AND (source <> ALL (ARRAY['olx'::text, 'facebook'::text])));
CREATE INDEX source_scans_scan_run_id_started_at_idx ON public.source_scans USING btree (scan_run_id, started_at) WHERE (scan_run_id IS NOT NULL);
CREATE INDEX source_scans_scan_run_idx ON public.source_scans USING btree (scan_run_id, started_at DESC);
CREATE INDEX source_scans_search_filter_id_started_at_idx ON public.source_scans USING btree (search_filter_id, started_at DESC);
CREATE INDEX source_scans_source_started_at_idx ON public.source_scans USING btree (source, started_at DESC);
CREATE INDEX watched_facebook_groups_enabled_priority_idx ON public.watched_facebook_groups USING btree (enabled, priority);
CREATE OR REPLACE FUNCTION public.apply_confirmed_property_group_review_decision(p_listing_id uuid, p_decision text, p_reason text DEFAULT NULL::text, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(listing_id uuid, decision text, lifecycle_status text, membership_count bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  target_identity text;
  member_ids uuid[];
  normalized_decision text := upper(trim(coalesce(p_decision, '')));
  normalized_reason text := nullif(trim(p_reason), '');
  affected_memberships bigint := 0;
begin
  if normalized_decision not in ('ACCEPTED', 'REJECTED') then
    raise exception 'LISTING_REVIEW_INVALID_DECISION' using errcode = '22023';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception 'LISTING_REVIEW_REASON_TOO_LONG' using errcode = '22023';
  end if;

  select l.cross_source_identity into target_identity
  from public.listings l where l.id = p_listing_id for update;
  if not found then raise exception 'LISTING_REVIEW_NOT_FOUND' using errcode = 'P0002'; end if;

  if target_identity is null then
    return query select * from public.apply_listing_review_decision(p_listing_id, normalized_decision, normalized_reason, p_now);
    return;
  end if;

  select array_agg(id order by id) into member_ids
  from (select l.id from public.listings l where l.cross_source_identity = target_identity order by l.id for update) members;
  if coalesce(cardinality(member_ids), 0) < 2 then
    return query select * from public.apply_listing_review_decision(p_listing_id, normalized_decision, normalized_reason, p_now);
    return;
  end if;
  if exists (
    select 1 from public.listings l where l.id = any(member_ids)
      and (l.lifecycle_status in ('STALE', 'ARCHIVED', 'REJECTED')
        or (normalized_decision = 'ACCEPTED' and l.manual_decision = 'REJECTED')
        or (normalized_decision = 'REJECTED' and l.manual_decision = 'ACCEPTED'))
  ) then
    raise exception 'LISTING_REVIEW_GROUP_INVALID_TRANSITION' using errcode = 'P0001';
  end if;

  if normalized_decision = 'ACCEPTED' then
    update public.listings l set lifecycle_status = 'ACTIVE', manual_decision = 'ACCEPTED',
      manual_decision_reason = normalized_reason, review_reason = null, missing_fields = '[]'::jsonb,
      archived_at = null, status = 'active'
    where l.id = any(member_ids);
    update public.listing_filter_matches m set is_current_match = true, last_matched_at = p_now,
      match_reasons = jsonb_build_array('manual_accept') || coalesce((
        select jsonb_agg(r.value order by r.position)
        from jsonb_array_elements_text(coalesce(m.match_reasons, '[]'::jsonb)) with ordinality r(value, position)
        where r.value <> 'manual_accept' and r.value <> 'review' and r.value not like 'unknown\_%' escape '\'
      ), '[]'::jsonb)
    where m.listing_id = any(member_ids);
  else
    update public.listings l set lifecycle_status = 'REJECTED', manual_decision = 'REJECTED',
      manual_decision_reason = normalized_reason, review_reason = null, missing_fields = '[]'::jsonb,
      archived_at = coalesce(l.archived_at, p_now)
    where l.id = any(member_ids);
    update public.listing_filter_matches m set is_current_match = false
    where m.listing_id = any(member_ids);
  end if;
  get diagnostics affected_memberships = row_count;

  return query select p_listing_id, normalized_decision, l.lifecycle_status, affected_memberships
  from public.listings l where l.id = p_listing_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.apply_investment_override_cas(p_deal_id uuid, p_expected_version integer, p_values jsonb, p_invalidated text[] DEFAULT '{}'::text[], p_events jsonb DEFAULT '[]'::jsonb, p_user_id text DEFAULT 'application'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_version integer;
begin
  if p_deal_id is null or p_expected_version is null or p_expected_version < 1
     or jsonb_typeof(coalesce(p_values, '{}'::jsonb)) <> 'object' then
    raise exception 'INVESTMENT_OVERRIDE_INVALID';
  end if;

  update public.deals d
  set verify = case when 'VERIFY' = any(p_invalidated) then jsonb_set(coalesce(d.verify, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.verify end,
      market = case when 'MARKET' = any(p_invalidated) then jsonb_set(coalesce(d.market, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.market end,
      underwriting = case when 'UNDERWRITER' = any(p_invalidated) then jsonb_set(coalesce(d.underwriting, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.underwriting end,
      ceo = case when 'CEO' = any(p_invalidated) then jsonb_set(coalesce(d.ceo, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.ceo end,
      version = d.version + 1,
      updated_at = now()
  where d.id = p_deal_id and d.version = p_expected_version
  returning d.version into v_version;

  if v_version is null then
    raise exception using errcode = 'P0001', message = 'INVESTMENT_DEAL_VERSION_CONFLICT';
  end if;

  insert into public.deal_fact_overrides(deal_id, values, updated_at)
  values (p_deal_id, coalesce(p_values, '{}'::jsonb), now())
  on conflict (deal_id) do update set values = excluded.values, updated_at = now();

  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) = 'array' then
    insert into public.deal_fact_override_events(deal_id, field, override_value, source_evidence_ids, conflict_status, user_id, confirmation_reason, confirmed_at, content_hash)
    select p_deal_id, left(entry->>'field', 120), entry->'overrideValue', coalesce(entry->'sourceEvidenceIds', '[]'::jsonb),
      case when entry->>'conflictStatus' in ('NONE','CRITICAL') then entry->>'conflictStatus' else 'NONE' end,
      left(coalesce(nullif(p_user_id, ''), 'application'), 200), null, null, left(coalesce(entry->>'contentHash', md5(entry::text)), 200)
    from jsonb_array_elements(p_events) as entry
    where jsonb_typeof(entry) = 'object' and nullif(entry->>'field', '') is not null
    on conflict (deal_id, field, content_hash) do nothing;
  end if;
  return v_version;
end;
$function$

CREATE OR REPLACE FUNCTION public.apply_listing_review_decision(p_listing_id uuid, p_decision text, p_reason text DEFAULT NULL::text, p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(listing_id uuid, decision text, lifecycle_status text, membership_count bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  target public.listings%rowtype;
  normalized_decision text := upper(trim(coalesce(p_decision, '')));
  normalized_reason text := nullif(trim(p_reason), '');
  affected_memberships bigint := 0;
begin
  if normalized_decision not in ('ACCEPTED', 'REJECTED') then
    raise exception 'LISTING_REVIEW_INVALID_DECISION' using errcode = '22023';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception 'LISTING_REVIEW_REASON_TOO_LONG' using errcode = '22023';
  end if;

  select l.*
  into target
  from public.listings as l
  where l.id = p_listing_id
  for update;

  if not found then
    raise exception 'LISTING_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not (
    (target.lifecycle_status = 'REVIEW' and target.manual_decision is null)
    or (normalized_decision = 'ACCEPTED' and target.lifecycle_status = 'ACTIVE' and target.manual_decision = 'ACCEPTED')
    or (normalized_decision = 'REJECTED' and target.lifecycle_status = 'REJECTED' and target.manual_decision = 'REJECTED')
  ) then
    raise exception 'LISTING_REVIEW_INVALID_TRANSITION:%:%', coalesce(target.lifecycle_status, 'NULL'), coalesce(target.manual_decision, 'NULL')
      using errcode = 'P0001';
  end if;

  if normalized_decision = 'ACCEPTED' then
    update public.listings as l
    set lifecycle_status = 'ACTIVE',
        manual_decision = 'ACCEPTED',
        manual_decision_reason = normalized_reason,
        review_reason = null,
        missing_fields = '[]'::jsonb,
        archived_at = null,
        status = 'active'
    where l.id = p_listing_id;

    update public.listing_filter_matches as membership
    set is_current_match = true,
        last_matched_at = p_now,
        match_reasons = jsonb_build_array('manual_accept') || coalesce((
          select jsonb_agg(reason.value order by reason.position)
          from jsonb_array_elements_text(coalesce(membership.match_reasons, '[]'::jsonb))
            with ordinality as reason(value, position)
          where reason.value <> 'manual_accept'
            and reason.value <> 'review'
            and reason.value not like 'unknown\_%' escape '\'
        ), '[]'::jsonb)
    where membership.listing_id = p_listing_id;
  else
    update public.listings as l
    set lifecycle_status = 'REJECTED',
        manual_decision = 'REJECTED',
        manual_decision_reason = normalized_reason,
        review_reason = null,
        missing_fields = '[]'::jsonb,
        archived_at = coalesce(l.archived_at, p_now)
    where l.id = p_listing_id;

    update public.listing_filter_matches as membership
    set is_current_match = false
    where membership.listing_id = p_listing_id;
  end if;

  get diagnostics affected_memberships = row_count;
  if affected_memberships = 0 then
    raise exception 'LISTING_REVIEW_MEMBERSHIP_MISSING' using errcode = 'P0001';
  end if;

  return query
  select p_listing_id, normalized_decision, l.lifecycle_status, affected_memberships
  from public.listings as l
  where l.id = p_listing_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.assign_price_radar_district_queue_candidate(p_owner_id uuid, p_queue_id uuid, p_district text, p_assigned_by uuid, p_confirmed jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  queue_row public.price_radar_district_queue%rowtype;
  existing_id uuid;
  saved_id uuid;
  inherited_excluded_at timestamptz;
  inherited_excluded_reason text;
begin
  if p_district not in ('Bałuty','Górna','Polesie','Śródmieście','Widzew') then
    raise exception 'INVALID_DISTRICT';
  end if;

  select * into queue_row from public.price_radar_district_queue q
   where q.id = p_queue_id and q.owner_id = p_owner_id for update;
  if not found then raise exception 'QUEUE_CANDIDATE_NOT_FOUND'; end if;

  select l.id into existing_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = queue_row.source
     and (l.external_listing_id = queue_row.external_listing_id or l.normalized_url = queue_row.normalized_url)
   order by (l.external_listing_id = queue_row.external_listing_id) desc, l.last_seen_at desc
   limit 1 for update;

  if nullif(queue_row.cross_source_identity, '') is not null then
    select l.excluded_at, l.excluded_reason into inherited_excluded_at, inherited_excluded_reason
      from public.price_radar_listings l
     where l.owner_id = p_owner_id and l.cross_source_identity = queue_row.cross_source_identity and l.excluded_at is not null
     order by l.excluded_at desc limit 1 for update;
  end if;

  if existing_id is not null then
    update public.price_radar_listings l set
      external_listing_id = queue_row.external_listing_id, original_url = queue_row.original_url, normalized_url = queue_row.normalized_url,
      title = queue_row.title, description = queue_row.description, price = queue_row.price, area = queue_row.area, price_per_sqm = (p_confirmed->>'price_per_sqm')::numeric,
      rooms = queue_row.rooms, city = queue_row.city, district = p_district,
      building_type = p_confirmed->>'building_type', market_type = p_confirmed->>'market_type', renovation_status = p_confirmed->>'renovation_status',
      content_hash = queue_row.content_hash, cross_source_identity = nullif(queue_row.cross_source_identity, ''),
      published_at = queue_row.published_at, source_updated_at = queue_row.source_updated_at,
      collected_at = queue_row.collected_at, last_seen_at = queue_row.last_seen_at,
      excluded_at = coalesce(l.excluded_at, inherited_excluded_at), excluded_reason = coalesce(l.excluded_reason, inherited_excluded_reason),
      status = 'active', raw_payload = queue_row.raw_payload
    where l.id = existing_id returning l.id into saved_id;
  else
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description, price, area, price_per_sqm, rooms,
      city, district, building_type, market_type, renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, last_seen_at, excluded_at, excluded_reason, raw_payload
    ) values (
      p_owner_id, queue_row.source, queue_row.external_listing_id, queue_row.original_url, queue_row.normalized_url,
      queue_row.title, queue_row.description, queue_row.price, queue_row.area, (p_confirmed->>'price_per_sqm')::numeric, queue_row.rooms,
      queue_row.city, p_district, p_confirmed->>'building_type', p_confirmed->>'market_type', p_confirmed->>'renovation_status', queue_row.content_hash,
      nullif(queue_row.cross_source_identity, ''), queue_row.published_at, queue_row.source_updated_at,
      queue_row.collected_at, queue_row.last_seen_at, inherited_excluded_at, inherited_excluded_reason, queue_row.raw_payload
    ) returning id into saved_id;
  end if;

  update public.price_radar_district_queue q set
    status = 'assigned', assigned_district = p_district, assigned_by = p_assigned_by, assigned_at = now(),
    assignment_origin = 'dzielnica przypisana ręcznie', rejected_at = null, radar_listing_id = saved_id
   where q.id = p_queue_id;

  return saved_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.block_price_radar_olx_jobs()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.context_type is distinct from 'price_radar' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'RADAR_OLX_REMOVED: OLX is a Flip Finder-only source; Price Radar cannot queue OLX jobs';
  end if;
  if new.status in ('queued', 'running') then
    new.result_summary := coalesce(old.result_summary, '{}'::jsonb) || jsonb_build_object('radarOlxRemoved', jsonb_build_object(
      'at', now(), 'blockedTransition', old.status || '->' || new.status, 'previousErrorCode', old.error_code));
    new.status := 'failed';
    new.finished_at := now();
    new.lease_token := null;
    new.leased_until := null;
    new.error_code := 'RADAR_OLX_REMOVED';
    new.error_message := 'OLX usunięty z Radaru cen (tylko Flip Finder); zadania nie uruchomiono ani nie wznowiono.';
  end if;
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.checkpoint_price_radar_run(p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_checkpoint jsonb, p_source_statuses jsonb, p_scanned_count integer, p_qualified_count integer, p_status text, p_error_message text, p_lease_seconds integer DEFAULT 120)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 180 then raise exception 'invalid lease_seconds'; end if;
  update public.price_radar_runs r set checkpoint = p_checkpoint, source_statuses = p_source_statuses,
    scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = p_status,
    error_message = p_error_message,
    finished_at = case when p_status in ('completed', 'partial', 'failed') then now() else null end,
    lease_until = case when p_status in ('completed', 'partial', 'failed') then null else now() + make_interval(secs => p_lease_seconds) end,
    lease_token = case when p_status in ('completed', 'partial', 'failed') then null else r.lease_token end
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_lease_token and r.lease_until > now()
     and (r.stop_requested_at is null or (p_status = 'partial' and p_error_message = 'RADAR_STOPPED_BY_OPERATOR'));
  return found;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_facebook_scan_job(p_worker_id text, p_lease_seconds integer DEFAULT 180, p_consumer_type text DEFAULT 'LEGACY_WORKER'::text)
 RETURNS SETOF facebook_scan_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claimed public.facebook_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;
  if p_consumer_type not in ('BROWSER_EXTENSION', 'LEGACY_WORKER') then
    raise exception 'consumer_type is invalid';
  end if;

  with exhausted as (
    update public.facebook_scan_jobs as jobs
       set status = 'failed', finished_at = now(), leased_until = null,
           lease_token = null, error_code = 'LEASE_EXHAUSTED',
           error_message = 'Facebook worker lease expired after maximum attempts'
     where jobs.status = 'running' and jobs.leased_until < now() and jobs.attempts >= jobs.max_attempts
     returning jobs.source_scan_id
  )
  update public.source_scans scans
     set status = 'failed', finished_at = now(),
         error_message = 'Facebook worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted where source_scan_id is not null)
     and scans.status in ('pending', 'running');

  update public.facebook_scan_jobs as jobs
     set status = 'queued', available_at = now(), leased_until = null,
         lease_token = null, worker_id = null, error_code = 'LEASE_RECOVERED',
         error_message = 'Previous Facebook worker lease expired'
   where jobs.status = 'running' and jobs.leased_until < now() and jobs.attempts < jobs.max_attempts;

  select * into claimed
    from public.facebook_scan_jobs as jobs
   where jobs.status = 'queued'
     and jobs.consumer_type = p_consumer_type
     and jobs.available_at <= now()
     and jobs.attempts < jobs.max_attempts
   order by jobs.priority desc, jobs.created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.facebook_scan_jobs as jobs
     set status = 'running', attempts = jobs.attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), worker_id = p_worker_id,
         started_at = coalesce(jobs.started_at, now()), error_code = null,
         error_message = null
   where jobs.id = claimed.id
   returning * into claimed;

  if claimed.source_scan_id is not null then
    update public.source_scans
       set status = 'running', error_message = null
     where id = claimed.source_scan_id and status = 'pending';
  end if;

  if claimed.job_type = 'GALLERY_HYDRATION' and claimed.gallery_listing_id is not null then
    update public.listings
       set gallery_status = 'RUNNING', gallery_job_id = claimed.id
     where id = claimed.gallery_listing_id;
  end if;

  return next claimed;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_finder_scan_source(p_cycle_at timestamp with time zone, p_now timestamp with time zone DEFAULT now(), p_lease_seconds integer DEFAULT 240)
 RETURNS SETOF source_scans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claimed_id uuid;
begin
  if p_cycle_at is null or p_now is null then
    raise exception 'continuation timestamps are required';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid continuation lease';
  end if;

  select id into claimed_id
    from public.source_scans
   where source not in ('olx', 'facebook')
     and (continuation_next_at is null or continuation_next_at <= p_now)
     and (continuation_cycle_at is null or continuation_cycle_at < p_cycle_at)
     and (
       status = 'pending'
       or (
         status = 'running'
         and (
           (continuation_lease_until is not null and continuation_lease_until <= p_now)
           or (
             continuation_lease_until is null
             and started_at <= p_now - interval '5 minutes'
           )
         )
       )
     )
   order by coalesce(continuation_next_at, started_at), started_at
   for update skip locked
   limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
    update public.source_scans
       set status = 'running',
           continuation_attempt = continuation_attempt + 1,
           continuation_cycle_at = p_cycle_at,
           continuation_lease_token = gen_random_uuid(),
           continuation_lease_until = p_now + make_interval(secs => p_lease_seconds)
     where id = claimed_id
     returning *;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_olx_scan_job(p_worker_id text, p_lease_seconds integer DEFAULT 120)
 RETURNS SETOF olx_scan_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claimed public.olx_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  -- Shared with claim_olx_scan_job_selective and claim_scheduled_finder_olx_job.
  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  -- Lease recovery as before, for every job except automatic ones.
  with exhausted as (
    update public.olx_scan_jobs
       set status = 'failed',
           finished_at = now(),
           leased_until = null,
           lease_token = null,
           error_code = 'LEASE_EXHAUSTED',
           error_message = 'Worker lease expired after maximum attempts'
     where status = 'running'
       and leased_until < now()
       and attempts >= max_attempts
       and requested_by is distinct from 'scheduler'
     returning source_scan_id
  )
  update public.source_scans scans
     set status = 'failed',
         finished_at = now(),
         error_message = 'OLX worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted)
     and scans.status in ('pending', 'running');

  update public.olx_scan_jobs
     set status = 'queued',
         available_at = now(),
         leased_until = null,
         lease_token = null,
         worker_id = null,
         error_code = 'LEASE_RECOVERED',
         error_message = 'Previous worker lease expired'
   where status = 'running'
     and leased_until < now()
     and attempts < max_attempts
     and requested_by is distinct from 'scheduler';

  -- Never next to a running automatic job (one browser lane for old and new Worker).
  if exists (
    select 1 from public.olx_scan_jobs j
     where j.requested_by = 'scheduler' and j.status = 'running' and j.leased_until > now()
  ) then
    return;
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where status = 'queued'
     and available_at <= now()
     and requested_by is distinct from 'scheduler'
   order by created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.olx_scan_jobs
     set status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         worker_id = p_worker_id,
         started_at = coalesce(started_at, now()),
         error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id
     and status = 'pending';

  return next claimed;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_olx_scan_job_selective(p_worker_id text, p_job_id uuid, p_lease_seconds integer DEFAULT 120)
 RETURNS SETOF olx_scan_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claimed public.olx_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;

  if p_job_id is null then
    raise exception 'job_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  if exists (
    select 1 from public.olx_scan_jobs j
     where j.requested_by = 'scheduler' and j.status = 'running' and j.leased_until > now()
  ) then
    return;
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where id = p_job_id
     and status = 'queued'
     and context_type = 'finder'
     and requested_by is distinct from 'scheduler'
     and available_at <= now()
     and attempts < max_attempts
   for update skip locked;

  if claimed.id is null then
    return;
  end if;

  update public.olx_scan_jobs
     set status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         worker_id = p_worker_id,
         started_at = coalesce(started_at, now()),
         error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id
     and status = 'pending';

  return next claimed;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_price_radar_run(p_owner_id uuid, p_initial_checkpoint jsonb, p_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(run_id uuid, lease_token uuid, status text, checkpoint jsonb, source_statuses jsonb, scanned_count integer, qualified_count integer, started_at timestamp with time zone, error_message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_run public.price_radar_runs%rowtype;
  new_token uuid := gen_random_uuid();
begin
  if p_owner_id is null or jsonb_typeof(p_initial_checkpoint) <> 'object' then
    raise exception 'invalid Radar run claim';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 180 then
    raise exception 'lease_seconds must be between 30 and 180';
  end if;

  select * into current_run from public.price_radar_runs r
   where r.owner_id = p_owner_id and r.status in ('pending', 'running')
   order by r.started_at desc limit 1 for update;
  if found then
    -- A stop is an explicit operator decision. An expired lease must not
    -- silently turn it into an automatic continuation or a competing run.
    if current_run.stop_requested_at is not null then
      return;
    end if;
    if current_run.lease_until is not null and current_run.lease_until > now() then
      return;
    end if;
    update public.price_radar_runs r set status = 'running', lease_token = new_token,
      lease_until = now() + make_interval(secs => p_lease_seconds), error_message = null
     where r.id = current_run.id
     returning r.id, r.lease_token, r.status, r.checkpoint, r.source_statuses, r.scanned_count, r.qualified_count, r.started_at, r.error_message
       into run_id, lease_token, status, checkpoint, source_statuses, scanned_count, qualified_count, started_at, error_message;
    update public.olx_scan_jobs j set radar_lease_token = new_token
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = current_run.id
       and j.status = 'queued';
    update public.olx_scan_jobs j set status = 'queued', available_at = now(), lease_token = null, leased_until = null,
      worker_id = null, heartbeat_at = now(), radar_lease_token = new_token,
      error_code = 'RADAR_LEASE_RECLAIMED', error_message = 'Prior Radar owner lease expired; worker job was requeued'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = current_run.id
       and j.status = 'running';
    return next;
    return;
  end if;

  insert into public.price_radar_runs as r (owner_id, status, checkpoint, lease_token, lease_until)
  values (p_owner_id, 'running', p_initial_checkpoint, new_token, now() + make_interval(secs => p_lease_seconds))
  returning r.id, r.lease_token, r.status, r.checkpoint, r.source_statuses, r.scanned_count, r.qualified_count, r.started_at, r.error_message
    into run_id, lease_token, status, checkpoint, source_statuses, scanned_count, qualified_count, started_at, error_message;
  return next;
exception when unique_violation then
  return;
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_scheduled_finder_olx_job(p_worker_id text, p_lease_seconds integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  control public.olx_automation_control%rowtype;
  claimed public.olx_scan_jobs%rowtype;
  claims_24h integer;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  select * into control from public.olx_automation_control where id = 1;
  if not found or not control.scheduled_claim_enabled then
    return jsonb_build_object('job', null, 'reason', 'AUTOMATION_DISABLED');
  end if;

  if exists (
    select 1 from public.olx_scan_jobs j
     where j.status = 'running' and j.leased_until > now()
  ) then
    return jsonb_build_object('job', null, 'reason', 'OLX_JOB_RUNNING');
  end if;

  select count(*) into claims_24h
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.requested_by = 'scheduler'
     and j.started_at >= now() - interval '24 hours';
  if claims_24h >= control.max_claims_24h then
    return jsonb_build_object('job', null, 'reason', 'DAILY_CLAIM_USED');
  end if;

  select j.* into claimed
    from public.olx_scan_jobs j
    join public.search_filters f on f.id = j.search_filter_id
   where j.status = 'queued'
     and j.context_type = 'finder'
     and j.requested_by = 'scheduler'
     and j.attempts = 0
     and j.available_at <= now()
     and j.created_at > now() - make_interval(mins => control.unclaimed_expiry_minutes)
     and f.is_active
     and coalesce(f.sources, '[]'::jsonb) ? 'olx'
   order by j.created_at
   limit 1
   for update of j skip locked;

  if claimed.id is null then
    return jsonb_build_object('job', null, 'reason', 'NO_DUE_JOB');
  end if;

  update public.olx_scan_jobs
     set status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         worker_id = p_worker_id,
         started_at = coalesce(started_at, now()),
         error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id
     and status = 'pending';

  return jsonb_build_object('job', to_jsonb(claimed), 'reason', null);
end;
$function$

CREATE OR REPLACE FUNCTION public.claim_scheduled_finder_olx_job(p_worker_id text, p_lease_seconds integer, p_usage jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  control public.olx_automation_control%rowtype;
  claimed public.olx_scan_jobs%rowtype;
  claims_24h integer;
  account_ms integer;
  worker_ms integer;
  safe_ms integer;
  estimate_ms integer;
  budget_json jsonb;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 or length(p_worker_id) > 100 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-scheduled-claim', 0));

  select * into control from public.olx_automation_control where id = 1;
  if not found or not control.scheduled_claim_enabled then
    return jsonb_build_object('job', null, 'reason', 'AUTOMATION_DISABLED');
  end if;

  -- Usage report: all four numbers must be present, finite and in range;
  -- anything else (missing, string, negative, NULL) is "unknown" = no claim.
  if not coalesce(
       jsonb_typeof(p_usage) = 'object'
       and jsonb_typeof(p_usage->'accountBrowserMs') = 'number' and jsonb_typeof(p_usage->'workerBrowserMs') = 'number'
       and jsonb_typeof(p_usage->'safeBudgetMs') = 'number' and jsonb_typeof(p_usage->'jobEstimateMs') = 'number'
       and (p_usage->>'accountBrowserMs')::numeric between 0 and 86400000
       and (p_usage->>'workerBrowserMs')::numeric between 0 and 86400000
       and (p_usage->>'safeBudgetMs')::numeric between 0 and 86400000
       and (p_usage->>'jobEstimateMs')::numeric > 0 and (p_usage->>'jobEstimateMs')::numeric <= 86400000,
     false) then
    return jsonb_build_object('job', null, 'reason', 'BROWSER_USAGE_UNKNOWN');
  end if;
  account_ms := round((p_usage->>'accountBrowserMs')::numeric);
  worker_ms := round((p_usage->>'workerBrowserMs')::numeric);
  -- Never trust a budget above half of the Workers Free daily allowance.
  safe_ms := least(round((p_usage->>'safeBudgetMs')::numeric)::integer, 300000);
  estimate_ms := least(round((p_usage->>'jobEstimateMs')::numeric)::integer, 600000);

  insert into public.olx_cloud_budget as b (worker_id, reported_at, utc_day, account_browser_ms, worker_browser_ms, safe_budget_ms, job_estimate_ms)
  values (p_worker_id, now(), (now() at time zone 'UTC')::date, least(account_ms, 600000), least(worker_ms, 600000), safe_ms, estimate_ms)
  on conflict (worker_id) do update set reported_at = excluded.reported_at, utc_day = excluded.utc_day,
    account_browser_ms = excluded.account_browser_ms, worker_browser_ms = excluded.worker_browser_ms,
    safe_budget_ms = excluded.safe_budget_ms, job_estimate_ms = excluded.job_estimate_ms;
  budget_json := jsonb_build_object('account_browser_ms', account_ms, 'worker_browser_ms', worker_ms, 'safe_budget_ms', safe_ms, 'job_estimate_ms', estimate_ms);

  if greatest(account_ms, worker_ms) + estimate_ms > safe_ms then
    return jsonb_build_object('job', null, 'reason', 'BROWSER_BUDGET_INSUFFICIENT', 'budget', budget_json);
  end if;

  if exists (select 1 from public.olx_scan_jobs j where j.status = 'running' and j.leased_until > now()) then
    return jsonb_build_object('job', null, 'reason', 'OLX_JOB_RUNNING');
  end if;

  select count(*) into claims_24h
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.requested_by = 'scheduler'
     and j.started_at >= now() - interval '24 hours';
  if claims_24h >= control.max_claims_24h then
    return jsonb_build_object('job', null, 'reason', 'DAILY_CLAIM_USED');
  end if;

  select j.* into claimed
    from public.olx_scan_jobs j
    join public.search_filters f on f.id = j.search_filter_id
   where j.status = 'queued'
     and j.context_type = 'finder'
     and j.requested_by = 'scheduler'
     and j.attempts = 0
     and j.available_at <= now()
     and j.created_at > now() - make_interval(mins => control.unclaimed_expiry_minutes)
     and f.is_active
     and coalesce(f.sources, '[]'::jsonb) ? 'olx'
   order by j.created_at
   limit 1
   for update of j skip locked;

  if claimed.id is null then
    return jsonb_build_object('job', null, 'reason', 'NO_DUE_JOB');
  end if;

  update public.olx_scan_jobs
     set status = 'running', attempts = attempts + 1, lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(),
         worker_id = p_worker_id, started_at = coalesce(started_at, now()), error_code = null, error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans set status = 'running', error_message = null
   where id = claimed.source_scan_id and status = 'pending';

  return jsonb_build_object('job', to_jsonb(claimed), 'reason', null, 'budget', budget_json);
end;
$function$

CREATE OR REPLACE FUNCTION public.cleanup_listing_visibility_lifecycle(p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(stale_count bigint, archived_count bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  update public.listings
  set lifecycle_status = 'REJECTED'
  where manual_decision = 'REJECTED'
    and lifecycle_status <> 'REJECTED';

  update public.listings
  set lifecycle_status = 'ARCHIVED', archived_at = coalesce(archived_at, p_now)
  where lifecycle_status in ('ACTIVE', 'REVIEW', 'STALE')
    and manual_decision is distinct from 'REJECTED'
    and last_seen_at is not null
    and last_seen_at < p_now - interval '14 days';
  get diagnostics archived_count = row_count;

  update public.listings
  set lifecycle_status = 'STALE'
  where lifecycle_status in ('ACTIVE', 'REVIEW')
    and manual_decision is distinct from 'REJECTED'
    and last_seen_at is not null
    and last_seen_at < p_now - interval '7 days'
    and last_seen_at >= p_now - interval '14 days';
  get diagnostics stale_count = row_count;

  return next;
end;
$function$

CREATE OR REPLACE FUNCTION public.clear_facebook_watcher_history_atomic()
 RETURNS TABLE(pure_facebook_listing_ids uuid[], preserved_listing_ids uuid[], removed_association_listing_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  pure_ids uuid[];
  preserved_ids uuid[];
begin
  lock table public.source_scans, public.facebook_scan_jobs, public.listings,
    public.listing_source_metadata, public.properties, public.deals
    in share row exclusive mode;

  if exists (select 1 from public.source_scans where source = 'facebook' and status in ('pending', 'running'))
     or exists (select 1 from public.facebook_scan_jobs where job_type in ('SOURCE_SCAN', 'GALLERY_HYDRATION') and status in ('queued', 'claimed', 'running')) then
    raise exception 'ACTIVE_FACEBOOK_WORK';
  end if;

  with candidates as (
    select distinct m.listing_id,
      l.source as listing_source,
      (m.metadata @> '{"crossSourceMatch": true}'::jsonb) as cross_source,
      exists (select 1 from public.properties p where p.listing_id = m.listing_id) as linked_property,
      exists (select 1 from public.deals d where d.listing_id = m.listing_id) as linked_deal
    from public.listing_source_metadata m
    join public.listings l on l.id = m.listing_id
    where m.source = 'facebook'
  ), classified as (
    select listing_id,
      (listing_source <> 'facebook' or cross_source or linked_property or linked_deal) as preserved
    from candidates
  )
  select coalesce(array_agg(listing_id) filter (where not preserved), '{}'), coalesce(array_agg(listing_id) filter (where preserved), '{}')
    into pure_ids, preserved_ids
    from classified;

  if coalesce(array_length(pure_ids, 1), 0) > 0 then
    delete from public.listings where source = 'facebook' and id = any(pure_ids);
  end if;
  if coalesce(array_length(preserved_ids, 1), 0) > 0 then
    delete from public.listing_source_metadata where source = 'facebook' and listing_id = any(preserved_ids);
  end if;

  return query select coalesce(pure_ids, '{}'), coalesce(preserved_ids, '{}'), coalesce(preserved_ids, '{}');
end;
$function$

CREATE OR REPLACE FUNCTION public.confirm_investment_override(p_override_event_id uuid, p_deal_id uuid, p_field text, p_user_id text, p_reason text, p_confirmed_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$

CREATE OR REPLACE FUNCTION public.enqueue_facebook_gallery_job(p_listing_id uuid, p_search_filter_id uuid, p_post_id text, p_source_url text)
 RETURNS TABLE(job_id uuid, gallery_status text, job_created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target public.listings%rowtype;
  active_job public.facebook_scan_jobs%rowtype;
  new_job public.facebook_scan_jobs%rowtype;
begin
  select * into target
    from public.listings
   where id = p_listing_id
   for update;

  if target.id is null or target.source <> 'facebook' then
    raise exception 'FACEBOOK_GALLERY_LISTING_NOT_FOUND';
  end if;
  if target.lifecycle_status in ('REJECTED', 'ARCHIVED', 'STALE') or target.manual_decision = 'REJECTED' then
    raise exception 'FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE';
  end if;
  if p_post_id is null or p_post_id !~ '^[0-9]{5,30}$' or target.external_listing_id <> p_post_id then
    raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED';
  end if;
  if p_source_url is null or p_source_url !~ ('^https://(www[.])?facebook[.]com/groups/[^/]+/(posts|permalink)/' || p_post_id || '(/|$)') then
    raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED';
  end if;
  if not exists (
    select 1 from public.listing_filter_matches
     where listing_id = p_listing_id and search_filter_id = p_search_filter_id
  ) then
    raise exception 'FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING';
  end if;

  if target.gallery_status = 'COMPLETE' then
    return query select target.gallery_job_id, 'COMPLETE'::text, false;
    return;
  end if;

  select * into active_job
    from public.facebook_scan_jobs jobs
   where jobs.job_type = 'GALLERY_HYDRATION'
     and jobs.gallery_listing_id = p_listing_id
     and jobs.status in ('queued', 'running')
   order by jobs.created_at desc
   limit 1;

  if active_job.id is not null then
    update public.listings
       set gallery_status = case when active_job.status = 'running' then 'RUNNING' else 'PENDING' end,
           gallery_job_id = active_job.id,
           gallery_requested_at = coalesce(gallery_requested_at, now()),
           gallery_completed_at = null,
           gallery_error = null
     where id = p_listing_id;

    return query select active_job.id,
      case when active_job.status = 'running' then 'RUNNING'::text else 'PENDING'::text end,
      false;
    return;
  end if;

  insert into public.facebook_scan_jobs (
    scan_run_id,
    source_scan_id,
    search_filter_id,
    status,
    group_snapshot,
    idempotency_key,
    consumer_type,
    job_type,
    priority,
    gallery_listing_id,
    gallery_post_id,
    gallery_source_url,
    available_at
  ) values (
    gen_random_uuid(),
    null,
    p_search_filter_id,
    'queued',
    '[]'::jsonb,
    'gallery:' || p_listing_id::text || ':' || gen_random_uuid()::text,
    'BROWSER_EXTENSION',
    'GALLERY_HYDRATION',
    100,
    p_listing_id,
    p_post_id,
    p_source_url,
    now()
  ) returning * into new_job;

  update public.listings
     set gallery_status = 'PENDING',
         gallery_job_id = new_job.id,
         gallery_requested_at = now(),
         gallery_completed_at = null,
         gallery_error = null
   where id = p_listing_id;

  return query select new_job.id, 'PENDING'::text, true;
end;
$function$

CREATE OR REPLACE FUNCTION public.enqueue_scheduled_finder_olx_job(p_filter_id uuid, p_run_id uuid, p_request_url text, p_filter_snapshot jsonb, p_shared_limit integer DEFAULT 1, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  window_length constant interval := interval '24 hours';
  checked_at timestamptz := now();
  window_start timestamptz := checked_at - window_length;
  filter_row public.search_filters%rowtype;
  interval_minutes integer;
  grace interval;
  slot record;
  slot_row public.finder_olx_slots%rowtype;
  last_slot jsonb;
  last_job record;
  in_flight integer;
  automatic_limit integer;
  automation_enabled boolean;
  effective_shared integer;
  automatic_count integer;
  finder_other_count integer;
  radar_count integer;
  cloudflare_count integer;
  total_count integer;
  oldest_automatic timestamptz;
  shared_release timestamptz;
  budget record;
  budget_json jsonb := null;
  blocker text := null;
  reason text := null;
  next_allowed timestamptz;
  new_scan_id uuid;
  new_job_id uuid;
  slot_key text;
begin
  if p_shared_limit is null or p_shared_limit < 1 or p_shared_limit > 20 then
    raise exception 'p_shared_limit must be between 1 and 20';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('finder-olx-automatic-schedule', 0));

  select * into filter_row from public.search_filters where id = p_filter_id for update;
  if not found then
    return jsonb_build_object('decision', 'skipped', 'reason', 'FILTER_NOT_FOUND', 'checked_at', checked_at);
  end if;
  interval_minutes := filter_row.finder_olx_scan_interval_minutes;
  grace := make_interval(mins => least(180, interval_minutes / 2));
  select * into slot from public.finder_olx_slot_window(filter_row.finder_olx_schedule_anchor, interval_minutes, checked_at);
  if slot.current_slot is not null then
    select * into slot_row from public.finder_olx_slots s where s.search_filter_id = p_filter_id and s.slot_at = slot.current_slot;
  end if;

  select coalesce((select c.max_claims_24h from public.olx_automation_control c where c.id = 1), 1) into automatic_limit;
  select coalesce((select c.scheduled_claim_enabled from public.olx_automation_control c where c.id = 1), false) into automation_enabled;
  effective_shared := greatest(p_shared_limit, automatic_limit);

  select
    count(*) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler'),
    count(*) filter (where j.context_type = 'finder' and j.requested_by is distinct from 'scheduler'),
    count(*) filter (where j.context_type = 'price_radar'),
    count(*) filter (where coalesce(j.worker_id, '') like 'cloudflare%'),
    count(*),
    min(j.created_at) filter (where j.context_type = 'finder' and j.requested_by = 'scheduler')
    into automatic_count, finder_other_count, radar_count, cloudflare_count, total_count, oldest_automatic
    from public.olx_scan_jobs j
   where (j.created_at >= window_start or j.started_at >= window_start)
     -- Retired Radar jobs never ran in the window; they do not use the budget.
     and not (j.context_type = 'price_radar' and j.error_code = 'RADAR_OLX_REMOVED' and j.started_at is null);

  select j.created_at, j.status, j.requested_by into last_job
    from public.olx_scan_jobs j
   where j.context_type = 'finder' and j.search_filter_id = p_filter_id
   order by j.created_at desc limit 1;

  select count(*) into in_flight from (
    select 1 from public.olx_scan_jobs j
     where j.context_type = 'finder' and j.search_filter_id = p_filter_id and j.status in ('queued', 'running')
    union all
    select 1 from public.source_scans s
     where s.search_filter_id = p_filter_id and s.source = 'olx' and s.status in ('pending', 'running')
  ) pending;

  if total_count >= effective_shared then
    select greatest(j.created_at, coalesce(j.started_at, j.created_at)) + window_length into shared_release
      from public.olx_scan_jobs j
     where (j.created_at >= window_start or j.started_at >= window_start)
       and not (j.context_type = 'price_radar' and j.error_code = 'RADAR_OLX_REMOVED' and j.started_at is null)
     order by greatest(j.created_at, coalesce(j.started_at, j.created_at)) asc
     offset (total_count - effective_shared) limit 1;
  end if;

  select * into budget from public.olx_cloud_budget_today(checked_at);
  if budget.worker_id is not null then
    budget_json := jsonb_build_object('reported_at', budget.reported_at, 'account_browser_ms', budget.account_browser_ms,
      'worker_browser_ms', budget.worker_browser_ms, 'safe_budget_ms', budget.safe_budget_ms, 'job_estimate_ms', budget.job_estimate_ms,
      'remaining_ms', budget.remaining_ms, 'fits_one_job', budget.fits_one_job);
  end if;

  select jsonb_build_object('slot_at', s.slot_at, 'status', s.status, 'reason', s.reason, 'decided_at', s.decided_at, 'job_id', s.job_id,
           'job_status', j.status, 'job_error_code', j.error_code, 'started_at', j.started_at, 'finished_at', j.finished_at,
           'worker_id', j.worker_id, 'delay_seconds', case when j.started_at is null then null else round(extract(epoch from (j.started_at - s.slot_at)))::integer end)
    into last_slot
    from public.finder_olx_slots s left join public.olx_scan_jobs j on j.id = s.job_id
   where s.search_filter_id = p_filter_id
   order by s.slot_at desc limit 1;

  if not filter_row.is_active then
    reason := 'FILTER_INACTIVE';
  elsif not (coalesce(filter_row.sources, '[]'::jsonb) ? 'olx') then
    reason := 'OLX_NOT_SELECTED';
  elsif slot.current_slot is null then
    reason := 'BEFORE_FIRST_SLOT';
  elsif slot_row.slot_at is not null then
    reason := 'SLOT_ALREADY_HANDLED';
  else
    if not automation_enabled then
      -- STOP: nothing would claim the job. Queue nothing (no job that can only
      -- end as NOT_CLAIMED, no use of the shared budget); past the grace the
      -- slot is recorded once as missed with this reason.
      blocker := 'AUTOMATION_DISABLED';
    elsif in_flight > 0 then
      blocker := 'OLX_JOB_IN_FLIGHT';
    elsif automatic_count >= automatic_limit then
      blocker := 'AUTOMATIC_DAILY_BUDGET_USED';
    elsif total_count >= effective_shared then
      blocker := 'SHARED_DAILY_BUDGET_USED';
    elsif budget.worker_id is not null and not budget.fits_one_job then
      blocker := 'BROWSER_BUDGET_INSUFFICIENT';
    elsif exists (
      -- Fairness for one shared budget: another active OLX filter whose own
      -- current slot is open and undecided, with an older last OLX order, goes first.
      select 1
        from public.search_filters f
        cross join lateral public.finder_olx_slot_window(f.finder_olx_schedule_anchor, f.finder_olx_scan_interval_minutes, checked_at) w
        left join lateral (select max(j.created_at) as last_at from public.olx_scan_jobs j where j.context_type = 'finder' and j.search_filter_id = f.id) other_last on true
       where f.id <> p_filter_id and f.is_active and coalesce(f.sources, '[]'::jsonb) ? 'olx'
         and w.current_slot is not null
         and checked_at <= w.current_slot + make_interval(mins => least(180, f.finder_olx_scan_interval_minutes / 2))
         and not exists (select 1 from public.finder_olx_slots s where s.search_filter_id = f.id and s.slot_at = w.current_slot)
         and coalesce(other_last.last_at, '-infinity'::timestamptz) < coalesce(last_job.created_at, '-infinity'::timestamptz)
         and not exists (select 1 from public.olx_scan_jobs j where j.context_type = 'finder' and j.search_filter_id = f.id and j.status in ('queued', 'running'))
         and not exists (select 1 from public.source_scans s where s.search_filter_id = f.id and s.source = 'olx' and s.status in ('pending', 'running'))
    ) then
      blocker := 'ANOTHER_FILTER_FIRST';
    end if;

    if checked_at > slot.current_slot + grace then
      -- Too late for this slot: record it once as missed, never catch it up.
      reason := 'SLOT_MISSED';
      if not p_dry_run then
        insert into public.finder_olx_slots (search_filter_id, slot_at, status, reason, details)
        values (p_filter_id, slot.current_slot, 'missed', coalesce(blocker, 'NOT_ENQUEUED_WITHIN_GRACE'),
                jsonb_build_object('grace_minutes', extract(epoch from grace) / 60, 'checked_at', checked_at))
        on conflict do nothing;
      end if;
    else
      reason := blocker;
    end if;
  end if;

  if reason is null and not p_dry_run then
    if p_request_url is null or p_request_url !~ '^https://(www\.)?olx\.pl/' then
      raise exception 'invalid OLX request url';
    end if;
    if p_filter_snapshot is null or jsonb_typeof(p_filter_snapshot) <> 'object' then
      raise exception 'invalid filter snapshot';
    end if;
    slot_key := p_filter_id::text || ':olx-slot:' || floor(extract(epoch from slot.current_slot))::bigint::text;
    insert into public.source_scans (search_filter_id, source, status, scan_run_id, filter_snapshot)
    values (p_filter_id, 'olx', 'pending', p_run_id, p_filter_snapshot)
    returning id into new_scan_id;
    insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, filter_snapshot, idempotency_key, requested_by)
    values (p_run_id, new_scan_id, p_filter_id, p_request_url, p_filter_snapshot, slot_key, 'scheduler')
    returning id into new_job_id;
    insert into public.finder_olx_slots (search_filter_id, slot_at, status, job_id, details)
    values (p_filter_id, slot.current_slot, 'enqueued', new_job_id, jsonb_build_object('run_id', p_run_id, 'checked_at', checked_at));
    automatic_count := automatic_count + 1;
    total_count := total_count + 1;
    last_slot := jsonb_build_object('slot_at', slot.current_slot, 'status', 'enqueued', 'reason', null, 'decided_at', checked_at, 'job_id', new_job_id,
      'job_status', 'queued', 'job_error_code', null, 'started_at', null, 'finished_at', null, 'worker_id', null, 'delay_seconds', null);
  end if;

  if reason is null or reason in ('SLOT_ALREADY_HANDLED', 'SLOT_MISSED', 'BEFORE_FIRST_SLOT') then
    next_allowed := slot.next_slot;
  elsif reason = 'AUTOMATION_DISABLED' then
    -- Switching the automation on within the grace still runs this slot.
    next_allowed := case when checked_at <= slot.current_slot + grace then checked_at else slot.next_slot end;
  elsif reason in ('OLX_JOB_IN_FLIGHT', 'AUTOMATIC_DAILY_BUDGET_USED', 'SHARED_DAILY_BUDGET_USED', 'BROWSER_BUDGET_INSUFFICIENT', 'ANOTHER_FILTER_FIRST') then
    next_allowed := greatest(checked_at,
      case when automatic_count >= automatic_limit then oldest_automatic + window_length else checked_at end,
      coalesce(shared_release, checked_at));
    -- Past this slot's grace the next chance is the next slot.
    if next_allowed > slot.current_slot + grace then next_allowed := slot.next_slot; end if;
  else
    next_allowed := null;
  end if;

  return jsonb_build_object(
    'decision', case when reason is not null then 'skipped' when p_dry_run then 'due' else 'enqueued' end,
    'reason', reason,
    'blocker', blocker,
    'checked_at', checked_at,
    'interval_minutes', interval_minutes,
    'start_time', to_char(filter_row.finder_olx_start_time, 'HH24:MI'),
    'time_zone', 'Europe/Warsaw',
    'anchor_local', to_char(filter_row.finder_olx_schedule_anchor, 'YYYY-MM-DD"T"HH24:MI'),
    'slot_at', slot.current_slot,
    'slot_local', to_char(slot.current_local, 'YYYY-MM-DD"T"HH24:MI'),
    'next_slot_at', slot.next_slot,
    'next_slot_local', to_char(slot.next_local, 'YYYY-MM-DD"T"HH24:MI'),
    'grace_until', case when slot.current_slot is null then null else slot.current_slot + grace end,
    'job_id', new_job_id,
    'source_scan_id', new_scan_id,
    'run_id', case when new_job_id is null then null else p_run_id end,
    'last_job_at', last_job.created_at,
    'last_job_status', last_job.status,
    'last_job_automatic', coalesce(last_job.requested_by = 'scheduler', false),
    'last_slot', last_slot,
    'next_allowed_at', next_allowed,
    'window_hours', 24,
    'automatic_jobs_in_window', automatic_count,
    'automatic_limit', automatic_limit,
    'finder_other_jobs_in_window', finder_other_count,
    'radar_jobs_in_window', radar_count,
    'cloudflare_jobs_in_window', cloudflare_count,
    'total_jobs_in_window', total_count,
    'shared_limit', effective_shared,
    'automation_enabled', automation_enabled,
    'browser_budget', budget_json
  );
end;
$function$

CREATE OR REPLACE FUNCTION public.expire_stale_scheduled_finder_olx_jobs()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  expiry_minutes integer;
  enabled boolean;
  stopped integer := 0;
  unclaimed integer := 0;
  lease_expired integer := 0;
begin
  select unclaimed_expiry_minutes, scheduled_claim_enabled into expiry_minutes, enabled
    from public.olx_automation_control where id = 1;
  expiry_minutes := coalesce(expiry_minutes, 360);
  enabled := coalesce(enabled, false);

  -- STOP: nothing will claim a queued automatic job; close it now, explicitly.
  if not enabled then
    with retired as (
      update public.olx_scan_jobs j
         set status = 'failed', finished_at = now(), leased_until = null,
             error_code = 'OLX_SCHEDULED_JOB_STOPPED',
             error_message = 'Automat OLX wyłączony (STOP) przed odbiorem zadania; nie uruchomiono, nie ponowiono, historia zachowana.'
       where j.context_type = 'finder' and j.requested_by = 'scheduler'
         and j.status = 'queued'
      returning j.source_scan_id
    ), scans as (
      update public.source_scans s
         set status = 'failed', finished_at = now(),
             error_message = 'OLX_SCHEDULED_JOB_STOPPED: automat OLX wyłączony przed odbiorem zadania'
       where s.id in (select source_scan_id from retired) and s.status in ('pending', 'running')
      returning 1
    )
    select count(*) into stopped from retired;
  end if;

  with expired as (
    update public.olx_scan_jobs j
       set status = 'failed', finished_at = now(), leased_until = null,
           error_code = 'OLX_SCHEDULED_JOB_NOT_CLAIMED',
           error_message = format('Automatyczne zadanie OLX nie zostało odebrane przez %s min; nie ponowiono, historia zachowana.', expiry_minutes)
     where j.context_type = 'finder' and j.requested_by = 'scheduler'
       and j.status = 'queued'
       and j.created_at <= now() - make_interval(mins => expiry_minutes)
    returning j.source_scan_id
  ), scans as (
    update public.source_scans s
       set status = 'failed', finished_at = now(),
           error_message = 'OLX_SCHEDULED_JOB_NOT_CLAIMED: automatyczne zadanie OLX nie zostało odebrane'
     where s.id in (select source_scan_id from expired) and s.status in ('pending', 'running')
    returning 1
  )
  select count(*) into unclaimed from expired;

  with expired as (
    update public.olx_scan_jobs j
       set status = 'failed', finished_at = now(), leased_until = null,
           error_code = 'OLX_SCHEDULED_JOB_LEASE_EXPIRED',
           error_message = 'Worker przestał odnawiać lease automatycznego zadania OLX; nie ponowiono, historia zachowana.'
     where j.context_type = 'finder' and j.requested_by = 'scheduler'
       and j.status = 'running'
       and j.leased_until < now() - interval '10 minutes'
    returning j.source_scan_id
  ), scans as (
    update public.source_scans s
       set status = 'failed', finished_at = now(),
           error_message = 'OLX_SCHEDULED_JOB_LEASE_EXPIRED: worker przestał odnawiać lease'
     where s.id in (select source_scan_id from expired) and s.status in ('pending', 'running')
    returning 1
  )
  select count(*) into lease_expired from expired;

  return jsonb_build_object('stopped', stopped, 'unclaimed_expired', unclaimed, 'lease_expired', lease_expired,
    'expiry_minutes', expiry_minutes, 'automation_enabled', enabled);
end;
$function$

CREATE OR REPLACE FUNCTION public.finalize_price_radar_olx_job(p_owner_id uuid, p_run_id uuid, p_radar_lease_token uuid, p_job_id uuid, p_worker_id text, p_job_lease_token uuid, p_checkpoint jsonb, p_source_statuses jsonb, p_scanned_count integer, p_qualified_count integer, p_run_status text, p_error_message text, p_job_status text, p_result_summary jsonb, p_error_code text, p_job_error_message text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_run public.price_radar_runs%rowtype;
  stopped_checkpoint jsonb;
  stopped_statuses jsonb;
begin
  if jsonb_typeof(p_checkpoint) <> 'object' or jsonb_typeof(p_source_statuses) <> 'object'
    or p_scanned_count < 0 or p_qualified_count < 0
    or p_run_status not in ('running','completed','partial','failed')
    or p_job_status not in ('completed','failed') then raise exception 'invalid Radar OLX finalization'; end if;
  select * into current_run from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now()
   for update;
  if not found then return false; end if;

  if current_run.stop_requested_at is not null then
    stopped_checkpoint := jsonb_set(current_run.checkpoint, '{sourceStatuses,olx}', '"pending"'::jsonb, true);
    stopped_statuses := jsonb_set(coalesce(current_run.source_statuses, '{}'::jsonb), '{olx}', '"pending"'::jsonb, true);
    update public.price_radar_runs r set checkpoint = stopped_checkpoint, source_statuses = stopped_statuses,
      scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = 'partial',
      error_message = 'RADAR_STOPPED_BY_OPERATOR', finished_at = now(), lease_until = null, lease_token = null
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
       and r.lease_token = p_radar_lease_token and r.lease_until > now();
    if not found then return false; end if;
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR', error_message = 'Operator stopped this Radar run',
      result_summary = coalesce(j.result_summary, '{}'::jsonb) || jsonb_build_object('stopped_at', now(), 'stop_reason', 'operator_request')
     where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id
       and j.radar_run_id = p_run_id and j.radar_lease_token = p_radar_lease_token
       and j.worker_id = p_worker_id and j.lease_token = p_job_lease_token and j.status = 'running' and j.leased_until > now();
    if not found then raise exception 'OLX_JOB_LEASE_LOST'; end if;
    return true;
  end if;

  update public.price_radar_runs r set checkpoint = p_checkpoint, source_statuses = p_source_statuses,
    scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = p_run_status,
    error_message = p_error_message,
    finished_at = case when p_run_status in ('completed','partial','failed') then now() else null end,
    lease_until = case when p_run_status in ('completed','partial','failed') then null else r.lease_until end,
    lease_token = case when p_run_status in ('completed','partial','failed') then null else r.lease_token end
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now() and r.stop_requested_at is null;
  if not found then return false; end if;
  update public.olx_scan_jobs j set status = p_job_status, finished_at = now(), leased_until = null,
    heartbeat_at = now(), result_summary = p_result_summary, error_code = p_error_code, error_message = p_job_error_message
   where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id
     and j.radar_run_id = p_run_id and j.radar_lease_token = p_radar_lease_token
     and j.worker_id = p_worker_id and j.lease_token = p_job_lease_token and j.status = 'running' and j.leased_until > now();
  if not found then raise exception 'OLX_JOB_LEASE_LOST'; end if;
  return true;
end;
$function$

CREATE OR REPLACE FUNCTION public.finder_olx_first_slot(p_start_time time without time zone, p_interval_minutes integer, p_now timestamp with time zone)
 RETURNS timestamp without time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with clock as (
    select (p_now at time zone 'Europe/Warsaw') as wall_now,
           ((p_now at time zone 'Europe/Warsaw')::date + p_start_time) as base,
           least(p_interval_minutes, 1440) * 60 as step_seconds
  )
  select base + make_interval(secs => step_seconds * ceil(greatest(0, extract(epoch from (wall_now - base))) / step_seconds))
    from clock;
$function$

CREATE OR REPLACE FUNCTION public.finder_olx_slot_window(p_anchor timestamp without time zone, p_interval_minutes integer, p_now timestamp with time zone)
 RETURNS TABLE(current_slot timestamp with time zone, next_slot timestamp with time zone, current_local timestamp without time zone, next_local timestamp without time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  wall_now timestamp := p_now at time zone 'Europe/Warsaw';
  k bigint;
begin
  if p_anchor is null or p_interval_minutes is null or p_interval_minutes <= 0 then
    return;
  end if;
  if wall_now < p_anchor then
    current_slot := null; current_local := null;
    next_local := p_anchor;
  else
    k := floor(extract(epoch from (wall_now - p_anchor)) / (p_interval_minutes * 60));
    current_local := p_anchor + make_interval(mins => (k * p_interval_minutes)::integer);
    next_local := current_local + make_interval(mins => p_interval_minutes);
    current_slot := current_local at time zone 'Europe/Warsaw';
  end if;
  next_slot := next_local at time zone 'Europe/Warsaw';
  return next;
end;
$function$

CREATE OR REPLACE FUNCTION public.get_facebook_watcher_history_summary()
 RETURNS TABLE(pure_facebook_listing_ids uuid[], preserved_listing_ids uuid[], removed_association_listing_ids uuid[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  pure_ids uuid[];
  preserved_ids uuid[];
begin
  with candidates as (
    select distinct m.listing_id,
      l.source as listing_source,
      (m.metadata @> '{"crossSourceMatch": true}'::jsonb) as cross_source,
      exists (select 1 from public.properties p where p.listing_id = m.listing_id) as linked_property,
      exists (select 1 from public.deals d where d.listing_id = m.listing_id) as linked_deal
    from public.listing_source_metadata m
    join public.listings l on l.id = m.listing_id
    where m.source = 'facebook'
  ), classified as (
    select listing_id,
      (listing_source <> 'facebook' or cross_source or linked_property or linked_deal) as preserved
    from candidates
  )
  select coalesce(array_agg(listing_id) filter (where not preserved), '{}'), coalesce(array_agg(listing_id) filter (where preserved), '{}')
    into pure_ids, preserved_ids
    from classified;

  return query select coalesce(pure_ids, '{}'), coalesce(preserved_ids, '{}'), coalesce(preserved_ids, '{}');
end;
$function$

CREATE OR REPLACE FUNCTION public.guard_scheduled_olx_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if old.requested_by is distinct from 'scheduler' then
    return new;
  end if;
  if new.attempts > 1 or (old.status <> 'queued' and new.status = 'queued') then
    raise exception 'OLX_SCHEDULED_JOB_NO_RETRY: automatic OLX job % is never retried or requeued', old.id;
  end if;
  if old.status = 'running' and new.status = 'running'
     and old.leased_until is not null and old.leased_until <= now()
     and new.leased_until is not null and new.leased_until > old.leased_until then
    raise exception 'OLX_SCHEDULED_JOB_LEASE_EXPIRED: the lease of automatic OLX job % expired and cannot be renewed', old.id;
  end if;
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.heartbeat_price_radar_olx_job(p_job_id uuid, p_worker_id text, p_job_lease_token uuid, p_radar_lease_token uuid, p_lease_seconds integer DEFAULT 120)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  job_context public.olx_scan_jobs%rowtype;
  radar_run public.price_radar_runs%rowtype;
  checkpoint jsonb;
  statuses jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then raise exception 'invalid lease_seconds'; end if;
  select * into job_context from public.olx_scan_jobs j
   where j.id = p_job_id and j.context_type = 'price_radar' and j.worker_id = p_worker_id
     and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token
     and j.status = 'running' and j.leased_until > now();
  if not found then return false; end if;
  select * into radar_run from public.price_radar_runs r
   where r.id = job_context.radar_run_id and r.owner_id = job_context.radar_owner_id
   for update;
  if not found then return false; end if;
  if radar_run.stop_requested_at is not null then
    checkpoint := jsonb_set(radar_run.checkpoint, '{sourceStatuses,olx}', '"pending"'::jsonb, true);
    statuses := jsonb_set(coalesce(radar_run.source_statuses, '{}'::jsonb), '{olx}', '"pending"'::jsonb, true);
    update public.price_radar_runs r set checkpoint = checkpoint, source_statuses = statuses,
      status = 'partial', error_message = 'RADAR_STOPPED_BY_OPERATOR', finished_at = now(),
      lease_token = null, lease_until = null
     where r.id = radar_run.id and r.owner_id = radar_run.owner_id and r.status = 'running'
       and r.lease_token = p_radar_lease_token and r.lease_until > now();
    if not found then return false; end if;
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR', error_message = 'Operator stopped this Radar run'
     where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = job_context.radar_owner_id
       and j.radar_run_id = job_context.radar_run_id and j.worker_id = p_worker_id
       and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token and j.status = 'running';
    return false;
  end if;
  if radar_run.status <> 'running' or radar_run.lease_token <> p_radar_lease_token or radar_run.lease_until <= now() then return false; end if;
  update public.olx_scan_jobs j set heartbeat_at = now(), leased_until = now() + make_interval(secs => p_lease_seconds)
   where j.id = p_job_id and j.context_type = 'price_radar' and j.worker_id = p_worker_id
     and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token
     and j.status = 'running' and j.leased_until > now();
  if not found then return false; end if;
  update public.price_radar_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
   where r.id = job_context.radar_run_id and r.owner_id = job_context.radar_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now() and r.stop_requested_at is null;
  if not found then raise exception 'RADAR_LEASE_LOST'; end if;
  return true;
end;
$function$

CREATE OR REPLACE FUNCTION public.manage_finder_listing_identity(p_owner_id uuid, p_search_filter_id uuid, p_action text, p_listing_a uuid, p_listing_b uuid DEFAULT NULL::uuid)
 RETURNS TABLE(action text, group_id uuid, affected_listing_ids uuid[])
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  normalized_action text := lower(trim(coalesce(p_action, '')));
  existing_group_ids uuid[];
  target_group uuid;
  members uuid[];
  removed_members uuid[];
  left_evidence jsonb;
  right_evidence jsonb;
  member_id uuid;
  pair_row record;
begin
  if p_owner_id is null or p_search_filter_id is null or p_listing_a is null then
    raise exception 'FINDER_IDENTITY_INVALID_ARGUMENT' using errcode = '22023';
  end if;
  if normalized_action not in ('link', 'not_link', 'unlink') then
    raise exception 'FINDER_IDENTITY_INVALID_ACTION' using errcode = '22023';
  end if;
  if not exists (select 1 from public.search_filters f where f.id = p_search_filter_id) then
    raise exception 'FINDER_IDENTITY_FILTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_search_filter_id::text, 0));
  if not exists (select 1 from public.listing_filter_matches m where m.search_filter_id = p_search_filter_id and m.listing_id = p_listing_a) then
    raise exception 'FINDER_IDENTITY_LISTING_OUTSIDE_FILTER' using errcode = '42501';
  end if;

  if normalized_action = 'unlink' then
    select g.group_id into target_group from public.finder_listing_identity_groups g
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id = p_listing_a
      for update;
    if not found then raise exception 'FINDER_IDENTITY_GROUP_NOT_FOUND' using errcode = 'P0002'; end if;
    select array_agg(g.listing_id order by g.listing_id) into members
      from public.finder_listing_identity_groups g
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
    removed_members := array_remove(members, p_listing_a);
    if coalesce(cardinality(removed_members), 0) = 0 then
      delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
      return query select normalized_action, null::uuid, array[p_listing_a]::uuid[];
      return;
    end if;
    delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id = p_listing_a;
    if cardinality(removed_members) = 1 then
      delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
    end if;
    foreach member_id in array removed_members loop
      insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
      values (p_owner_id, p_search_filter_id, least(p_listing_a, member_id), greatest(p_listing_a, member_id), 'not_link')
      on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'not_link', created_at = now();
    end loop;
    return query select normalized_action, null::uuid, array[p_listing_a]::uuid[];
    return;
  end if;

  if p_listing_b is null or p_listing_a = p_listing_b then
    raise exception 'FINDER_IDENTITY_PAIR_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.listing_filter_matches m where m.search_filter_id = p_search_filter_id and m.listing_id = p_listing_b) then
    raise exception 'FINDER_IDENTITY_LISTING_OUTSIDE_FILTER' using errcode = '42501';
  end if;

  if normalized_action = 'not_link' then
    insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
    values (p_owner_id, p_search_filter_id, least(p_listing_a, p_listing_b), greatest(p_listing_a, p_listing_b), 'not_link')
    on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'not_link', created_at = now();
    return query select normalized_action, null::uuid, array[least(p_listing_a,p_listing_b), greatest(p_listing_a,p_listing_b)]::uuid[];
    return;
  end if;

  -- Lock the filter's membership rows in deterministic order. The transaction
  -- serializes manual group edits for this filter without changing listings,
  -- match history, CRM rows, or Radar exclusions.
  perform 1 from public.listing_filter_matches m
    where m.search_filter_id = p_search_filter_id and m.listing_id in (p_listing_a, p_listing_b)
    order by m.listing_id for update;
  if exists (
    select 1 from public.listings l where l.id in (p_listing_a, p_listing_b)
      and (l.lifecycle_status = 'REJECTED' or l.manual_decision = 'REJECTED')
  ) then raise exception 'FINDER_IDENTITY_REJECTED_LISTING' using errcode = 'P0001'; end if;

  select array_agg(distinct g.group_id order by g.group_id) into existing_group_ids
    from public.finder_listing_identity_groups g
    where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id in (p_listing_a, p_listing_b);
  select array_agg(distinct ids.listing_id order by ids.listing_id) into members
    from (
      select p_listing_a as listing_id union select p_listing_b
      union select g.listing_id from public.finder_listing_identity_groups g
        where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = any(coalesce(existing_group_ids, array[]::uuid[]))
    ) ids;

  -- Manual confirmation can resolve missing evidence, but it cannot override
  -- explicit contradictory unit/building/market facts. Check every pair in
  -- the resulting group, not only the two buttons clicked by the operator.
  for pair_row in
    select l1.identity_evidence as left_evidence, l2.identity_evidence as right_evidence
    from public.listings l1 join public.listings l2 on l1.id < l2.id
    where l1.id = any(members) and l2.id = any(members)
  loop
    left_evidence := coalesce(pair_row.left_evidence, '{}'::jsonb);
    right_evidence := coalesce(pair_row.right_evidence, '{}'::jsonb);
    if (left_evidence->>'marketType' is not null and right_evidence->>'marketType' is not null and left_evidence->>'marketType' <> right_evidence->>'marketType')
      or (left_evidence->>'buildingType' is not null and right_evidence->>'buildingType' is not null and left_evidence->>'buildingType' <> right_evidence->>'buildingType')
      or (left_evidence->>'buildingKey' is not null and right_evidence->>'buildingKey' is not null and left_evidence->>'buildingKey' <> right_evidence->>'buildingKey')
      or (left_evidence->>'apartmentNumber' is not null and right_evidence->>'apartmentNumber' is not null and left_evidence->>'buildingKey' = right_evidence->>'buildingKey' and left_evidence->>'apartmentNumber' <> right_evidence->>'apartmentNumber')
      or (left_evidence#>>'{agencyReference,agency}' is not null and right_evidence#>>'{agencyReference,agency}' is not null and left_evidence#>>'{agencyReference,agency}' = right_evidence#>>'{agencyReference,agency}' and left_evidence#>>'{agencyReference,number}' <> right_evidence#>>'{agencyReference,number}')
      or (left_evidence->>'rooms' is not null and right_evidence->>'rooms' is not null and left_evidence->>'rooms' <> right_evidence->>'rooms')
      or (left_evidence->>'floor' is not null and right_evidence->>'floor' is not null and left_evidence->>'floor' <> right_evidence->>'floor')
      or (left_evidence->>'area' is not null and right_evidence->>'area' is not null and abs((left_evidence->>'area')::numeric - (right_evidence->>'area')::numeric) > greatest(0.3, least(0.8, greatest((left_evidence->>'area')::numeric, (right_evidence->>'area')::numeric) * 0.012)))
    then raise exception 'FINDER_IDENTITY_CONTRADICTORY_EVIDENCE' using errcode = '22023'; end if;
  end loop;

  target_group := coalesce(existing_group_ids[1], gen_random_uuid());
  if coalesce(cardinality(existing_group_ids), 0) > 0 then
    update public.finder_listing_identity_groups g set group_id = target_group
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = any(existing_group_ids);
  end if;
  insert into public.finder_listing_identity_groups(owner_id, search_filter_id, group_id, listing_id)
    select p_owner_id, p_search_filter_id, target_group, ids.listing_id from unnest(members) ids(listing_id)
    on conflict (owner_id, search_filter_id, listing_id) do update set group_id = excluded.group_id;
  insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
    values (p_owner_id, p_search_filter_id, least(p_listing_a, p_listing_b), greatest(p_listing_a, p_listing_b), 'link')
    on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'link', created_at = now();
  return query select normalized_action, target_group, members;
end;
$function$

CREATE OR REPLACE FUNCTION public.mark_investment_deal_stale_cas(p_deal_id uuid, p_expected_version integer, p_directors text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_version integer;
begin
  if p_deal_id is null or p_expected_version is null or p_expected_version < 1
     or coalesce(cardinality(p_directors), 0) = 0
     or exists (select 1 from unnest(p_directors) d where d not in ('MARKET','UNDERWRITER','CEO')) then
    raise exception 'INVESTMENT_DEAL_STALE_INVALID';
  end if;

  update public.deals d
  set market = case when 'MARKET' = any(p_directors) then jsonb_set(coalesce(d.market, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.market end,
      underwriting = case when 'UNDERWRITER' = any(p_directors) then jsonb_set(coalesce(d.underwriting, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.underwriting end,
      ceo = case when 'CEO' = any(p_directors) then jsonb_set(coalesce(d.ceo, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.ceo end,
      version = d.version + 1,
      updated_at = now()
  where d.id = p_deal_id and d.version = p_expected_version
  returning d.version into v_version;
  return v_version;
end;
$function$

CREATE OR REPLACE FUNCTION public.olx_cloud_budget_today(p_now timestamp with time zone)
 RETURNS TABLE(worker_id text, reported_at timestamp with time zone, account_browser_ms integer, worker_browser_ms integer, safe_budget_ms integer, job_estimate_ms integer, remaining_ms integer, fits_one_job boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select b.worker_id, b.reported_at, b.account_browser_ms, b.worker_browser_ms, b.safe_budget_ms, b.job_estimate_ms,
         greatest(0, b.safe_budget_ms - greatest(b.account_browser_ms, b.worker_browser_ms)) as remaining_ms,
         greatest(b.account_browser_ms, b.worker_browser_ms) + b.job_estimate_ms <= b.safe_budget_ms as fits_one_job
    from public.olx_cloud_budget b
   where b.utc_day = (p_now at time zone 'UTC')::date
   order by b.reported_at desc
   limit 1;
$function$

CREATE OR REPLACE FUNCTION public.persist_investment_deal_cas(p_deal jsonb, p_expected_version integer, p_source_updated_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deal_id uuid;
  v_listing_id uuid;
  v_version integer;
begin
  if p_deal is null or jsonb_typeof(p_deal) <> 'object' or p_expected_version is null or p_expected_version < 0 then
    raise exception 'INVESTMENT_DEAL_WRITE_INVALID';
  end if;

  v_deal_id := nullif(p_deal->>'id', '')::uuid;
  v_listing_id := nullif(p_deal->>'listing_id', '')::uuid;
  if v_deal_id is null or v_listing_id is null then
    raise exception 'INVESTMENT_DEAL_WRITE_INVALID';
  end if;

  -- The source snapshot must still be current at the instant the write commits.
  if not exists (
    select 1 from public.listings l
    where l.id = v_listing_id and l.updated_at is not distinct from p_source_updated_at
  ) then
    return null;
  end if;

  if p_expected_version = 0 then
    insert into public.deals (
      id, listing_id, stage, facts_fingerprint, facts, scout, verify, market,
      underwriting, ceo, playbook, evidence_fabric, information_requests,
      analysis_level, created_at, updated_at, version, source_updated_at
    ) values (
      v_deal_id, v_listing_id, p_deal->>'stage', p_deal->>'facts_fingerprint',
      coalesce(p_deal->'facts', '{}'::jsonb), coalesce(p_deal->'scout', '{}'::jsonb),
      coalesce(p_deal->'verify', '{}'::jsonb), coalesce(p_deal->'market', '{}'::jsonb),
      coalesce(p_deal->'underwriting', '{}'::jsonb), coalesce(p_deal->'ceo', '{}'::jsonb),
      coalesce(p_deal->'playbook', '{}'::jsonb), coalesce(p_deal->'evidence_fabric', '[]'::jsonb),
      coalesce(p_deal->'information_requests', '[]'::jsonb),
      coalesce((p_deal->>'analysis_level')::integer, 1),
      coalesce((p_deal->>'created_at')::timestamptz, now()), now(), 1, p_source_updated_at
    )
    on conflict (listing_id) do nothing
    returning version into v_version;
    return v_version;
  end if;

  update public.deals d
  set stage = p_deal->>'stage',
      facts_fingerprint = p_deal->>'facts_fingerprint',
      facts = coalesce(p_deal->'facts', '{}'::jsonb),
      scout = coalesce(p_deal->'scout', '{}'::jsonb),
      verify = coalesce(p_deal->'verify', '{}'::jsonb),
      market = coalesce(p_deal->'market', '{}'::jsonb),
      underwriting = coalesce(p_deal->'underwriting', '{}'::jsonb),
      ceo = coalesce(p_deal->'ceo', '{}'::jsonb),
      playbook = coalesce(p_deal->'playbook', '{}'::jsonb),
      evidence_fabric = coalesce(p_deal->'evidence_fabric', '[]'::jsonb),
      information_requests = coalesce(p_deal->'information_requests', '[]'::jsonb),
      analysis_level = coalesce((p_deal->>'analysis_level')::integer, 1),
      source_updated_at = p_source_updated_at,
      version = d.version + 1,
      updated_at = now()
  where d.id = v_deal_id
    and d.listing_id = v_listing_id
    and d.version = p_expected_version
    and exists (
      select 1 from public.listings l
      where l.id = d.listing_id and l.updated_at is not distinct from p_source_updated_at
    )
  returning d.version into v_version;

  return v_version;
end;
$function$

CREATE OR REPLACE FUNCTION public.persist_price_radar_listing(p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_listing jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  existing_id uuid;
  saved_id uuid;
  inherited_excluded_at timestamptz;
  inherited_excluded_reason text;
begin
  perform 1 from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_lease_token and r.lease_until > now()
   for update;
  if not found then raise exception 'RADAR_LEASE_LOST'; end if;

  select l.id into existing_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = p_listing->>'source'
     and (l.external_listing_id = p_listing->>'external_listing_id' or l.normalized_url = p_listing->>'normalized_url')
   order by (l.external_listing_id = p_listing->>'external_listing_id') desc, l.last_seen_at desc
   limit 1 for update;

  if nullif(p_listing->>'cross_source_identity', '') is not null then
    select l.excluded_at, l.excluded_reason into inherited_excluded_at, inherited_excluded_reason
      from public.price_radar_listings l
     where l.owner_id = p_owner_id and l.cross_source_identity = p_listing->>'cross_source_identity' and l.excluded_at is not null
     order by l.excluded_at desc limit 1 for update;
  end if;

  if existing_id is not null then
    update public.price_radar_listings l set
      external_listing_id = p_listing->>'external_listing_id', original_url = p_listing->>'original_url', normalized_url = p_listing->>'normalized_url',
      title = p_listing->>'title', description = p_listing->>'description', price = (p_listing->>'price')::numeric,
      area = (p_listing->>'area')::numeric, price_per_sqm = (p_listing->>'price_per_sqm')::numeric,
      rooms = nullif(p_listing->>'rooms', '')::integer, city = p_listing->>'city', district = p_listing->>'district',
      building_type = p_listing->>'building_type', market_type = p_listing->>'market_type', renovation_status = p_listing->>'renovation_status',
      content_hash = p_listing->>'content_hash', cross_source_identity = nullif(p_listing->>'cross_source_identity', ''),
      published_at = nullif(p_listing->>'published_at', '')::timestamptz, source_updated_at = nullif(p_listing->>'source_updated_at', '')::timestamptz,
      collected_at = (p_listing->>'collected_at')::timestamptz, last_seen_at = (p_listing->>'last_seen_at')::timestamptz,
      excluded_at = coalesce(l.excluded_at, inherited_excluded_at), excluded_reason = coalesce(l.excluded_reason, inherited_excluded_reason),
      status = 'active', raw_payload = coalesce(p_listing->'raw_payload', '{}'::jsonb)
    where l.id = existing_id returning l.id into saved_id;
  else
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description, price, area, price_per_sqm, rooms,
      city, district, building_type, market_type, renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, last_seen_at, excluded_at, excluded_reason, raw_payload
    ) values (
      p_owner_id, p_listing->>'source', p_listing->>'external_listing_id', p_listing->>'original_url', p_listing->>'normalized_url',
      p_listing->>'title', p_listing->>'description', (p_listing->>'price')::numeric, (p_listing->>'area')::numeric,
      (p_listing->>'price_per_sqm')::numeric, nullif(p_listing->>'rooms', '')::integer, p_listing->>'city', p_listing->>'district',
      p_listing->>'building_type', p_listing->>'market_type', p_listing->>'renovation_status', p_listing->>'content_hash',
      nullif(p_listing->>'cross_source_identity', ''), nullif(p_listing->>'published_at', '')::timestamptz,
      nullif(p_listing->>'source_updated_at', '')::timestamptz, (p_listing->>'collected_at')::timestamptz,
      (p_listing->>'last_seen_at')::timestamptz, inherited_excluded_at, inherited_excluded_reason, coalesce(p_listing->'raw_payload', '{}'::jsonb)
    ) returning id into saved_id;
  end if;
  return saved_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.prevent_investment_history_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'INVESTMENT_HISTORY_APPEND_ONLY:%', TG_TABLE_NAME;
end;
$function$

CREATE OR REPLACE FUNCTION public.reconcile_canonical_listing_decision(p_listing_id uuid, p_filter_id uuid, p_bucket text, p_reasons jsonb, p_missing_fields jsonb, p_lifecycle_status text, p_match_origin text DEFAULT 'scan'::text, p_source_scan_id uuid DEFAULT NULL::uuid, p_matched_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(listing_id uuid, search_filter_id uuid, bucket text, lifecycle_status text, is_current_match boolean, match_reasons jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target public.listings%rowtype;
  normalized_reasons jsonb;
  normalized_missing jsonb;
  current_match boolean;
  next_lifecycle text;
  cleared_at timestamptz;
begin
  if p_bucket not in ('MATCHED', 'REVIEW', 'REJECTED') then
    raise exception 'CANONICAL_BUCKET_INVALID';
  end if;

  if p_match_origin not in (
    'scan', 'filter_recalculation', 'collector_import'
  ) then
    raise exception 'CANONICAL_MATCH_ORIGIN_INVALID';
  end if;

  if jsonb_typeof(coalesce(p_reasons, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(
       coalesce(p_missing_fields, '[]'::jsonb)
     ) <> 'array' then
    raise exception 'CANONICAL_REASONS_INVALID';
  end if;

  select * into target
    from public.listings
   where id = p_listing_id
   for update;

  if target.id is null then
    raise exception 'CANONICAL_LISTING_NOT_FOUND';
  end if;

  if not exists (
    select 1
      from public.search_filters
     where id = p_filter_id
  ) then
    raise exception 'CANONICAL_FILTER_NOT_FOUND';
  end if;

  select m.last_matched_at into cleared_at
    from public.listing_filter_matches as m
   where m.listing_id = p_listing_id
     and m.search_filter_id = p_filter_id
     and m.is_current_match = false
     and m.match_reasons ? 'finder_cleared'
   for update;

  if found and (
    cleared_at is null
    or p_matched_at is null
    or p_matched_at <= cleared_at
  ) then
    return query
      select
        p_listing_id,
        p_filter_id,
        'REJECTED'::text,
        target.lifecycle_status,
        false,
        jsonb_build_array('finder_cleared');
    return;
  end if;

  normalized_reasons := coalesce(p_reasons, '[]'::jsonb);
  normalized_missing := coalesce(p_missing_fields, '[]'::jsonb);

  if target.manual_decision = 'REJECTED' then
    normalized_reasons := jsonb_build_array('manual_rejected');
    normalized_missing := '[]'::jsonb;
    current_match := false;
    next_lifecycle := coalesce(target.lifecycle_status, 'REJECTED');

  elsif target.lifecycle_status = 'ARCHIVED' then
    normalized_reasons := jsonb_build_array('archived');
    normalized_missing := '[]'::jsonb;
    current_match := false;
    next_lifecycle := 'ARCHIVED';

  else
    current_match := p_bucket = 'MATCHED';
    next_lifecycle := case
      when p_bucket = 'MATCHED' then 'ACTIVE'
      else p_lifecycle_status
    end;
  end if;

  if next_lifecycle not in (
    'ACTIVE', 'REVIEW', 'REJECTED', 'STALE', 'ARCHIVED'
  ) then
    raise exception 'CANONICAL_LIFECYCLE_INVALID';
  end if;

  if target.manual_decision is distinct from 'REJECTED'
     and target.lifecycle_status is distinct from 'ARCHIVED'
     and p_bucket = 'REVIEW'
     and not (normalized_reasons ? 'review') then
    normalized_reasons :=
      jsonb_build_array('review') || normalized_reasons;
  end if;

  if target.manual_decision is distinct from 'REJECTED'
     and target.lifecycle_status is distinct from 'ARCHIVED'
     and p_bucket = 'REVIEW' then
    normalized_reasons := normalized_reasons || coalesce(
      (
        select jsonb_agg('unknown_' || value)
          from jsonb_array_elements_text(
            normalized_missing
          ) as fields(value)
         where not (
           normalized_reasons ? ('unknown_' || value)
         )
      ),
      '[]'::jsonb
    );
  end if;

  if target.manual_decision is distinct from 'REJECTED'
     and target.lifecycle_status is distinct from 'ARCHIVED' then
    update public.listings
       set lifecycle_status = next_lifecycle,
           archived_at = case
             when p_bucket in ('MATCHED', 'REVIEW') then null
             else archived_at
           end,
           review_reason = case
             when p_bucket = 'REVIEW' then
               array_to_string(
                 array(
                   select jsonb_array_elements_text(
                     normalized_reasons
                   )
                 ),
                 ', '
               )
             else null
           end,
           missing_fields = case
             when p_bucket = 'REVIEW' then normalized_missing
             else '[]'::jsonb
           end,
           status = 'active'
     where id = p_listing_id;
  end if;

  insert into public.listing_filter_matches (
    listing_id,
    search_filter_id,
    last_matched_at,
    is_current_match,
    match_reasons,
    match_origin,
    source_scan_id
  ) values (
    p_listing_id,
    p_filter_id,
    coalesce(p_matched_at, now()),
    current_match,
    normalized_reasons,
    p_match_origin,
    p_source_scan_id
  )
  on conflict on constraint listing_filter_matches_pkey
  do update set
    last_matched_at = excluded.last_matched_at,
    is_current_match = excluded.is_current_match,
    match_reasons = excluded.match_reasons,
    match_origin = excluded.match_origin,
    source_scan_id = excluded.source_scan_id;

  return query
    select
      p_listing_id,
      p_filter_id,
      case
        when target.manual_decision = 'REJECTED'
          or target.lifecycle_status = 'ARCHIVED'
        then 'REJECTED'::text
        else p_bucket
      end,
      next_lifecycle,
      current_match,
      normalized_reasons;
end;
$function$

CREATE OR REPLACE FUNCTION public.renew_facebook_scan_job(p_job_id uuid, p_worker_id text, p_lease_token uuid, p_lease_seconds integer DEFAULT 180)
 RETURNS TABLE(job_id uuid, leased_until timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  return query
  update public.facebook_scan_jobs as jobs
     set heartbeat_at = now(),
         leased_until = now() + make_interval(secs => p_lease_seconds)
   where jobs.id = p_job_id
     and jobs.consumer_type = 'BROWSER_EXTENSION'
     and jobs.status = 'running'
     and jobs.lease_token = p_lease_token
     and jobs.worker_id = p_worker_id
     and jobs.leased_until >= now()
   returning jobs.id, jobs.leased_until;
end;
$function$

CREATE OR REPLACE FUNCTION public.repair_facebook_gallery_job(p_listing_id uuid)
 RETURNS TABLE(listing_id uuid, gallery_job_id uuid, expected_post_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target public.listings%rowtype;
  metadata_row public.listing_source_metadata%rowtype;
  metadata_count integer;
  listing_post_id text;
  listing_group text;
  metadata_group text;
  filter_id uuid;
  active_job uuid;
  new_job public.facebook_scan_jobs%rowtype;
  next_metadata jsonb;
begin
  select * into target from public.listings where id = p_listing_id for update;
  if target.id is null or target.source <> 'facebook' then raise exception 'FACEBOOK_GALLERY_LISTING_NOT_FOUND'; end if;
  if target.lifecycle_status in ('REJECTED', 'ARCHIVED', 'STALE') or target.manual_decision = 'REJECTED' then raise exception 'FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE'; end if;

  listing_post_id := substring(target.external_listing_id from '^([0-9]{5,30})$');
  listing_group := substring(target.original_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/[0-9]{5,30}(?:/|$)');
  if listing_post_id is null or listing_group is null then raise exception 'FACEBOOK_GALLERY_EXACT_POST_REQUIRED'; end if;

  select count(*) into metadata_count
    from public.listing_source_metadata m
   where m.listing_id = p_listing_id
     and m.source = 'facebook'
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') is not null
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/[^/]+/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') = listing_post_id;
  if metadata_count <> 1 then raise exception 'FACEBOOK_GALLERY_METADATA_IDENTITY_AMBIGUOUS'; end if;

  select * into metadata_row
    from public.listing_source_metadata m
   where m.listing_id = p_listing_id
     and m.source = 'facebook'
     and substring(m.source_post_url from '^https://(?:www\.)?facebook\.com/groups/[^/]+/(?:posts|permalink)/([0-9]{5,30})(?:/|$)') = listing_post_id
   order by m.collected_at desc
   limit 1
   for update;
  metadata_group := substring(metadata_row.source_post_url from '^https://(?:www\.)?facebook\.com/groups/([^/]+)/(?:posts|permalink)/[0-9]{5,30}(?:/|$)');
  if metadata_group is null or metadata_group <> listing_group then raise exception 'FACEBOOK_GALLERY_METADATA_GROUP_MISMATCH'; end if;

  select m.search_filter_id into filter_id
    from public.listing_filter_matches m
   where m.listing_id = p_listing_id
     and (m.is_current_match = true or m.match_reasons ? 'review' or exists (
       select 1 from jsonb_array_elements_text(coalesce(m.match_reasons, '[]'::jsonb)) reasons(value) where reasons.value like 'unknown_%'
     ))
   order by m.last_matched_at desc
   limit 1;
  if filter_id is null then raise exception 'FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING'; end if;

  select jobs.id into active_job
    from public.facebook_scan_jobs jobs
   where jobs.job_type = 'GALLERY_HYDRATION'
     and jobs.gallery_listing_id = p_listing_id
     and jobs.status in ('queued', 'claimed', 'running')
   order by jobs.created_at desc
   limit 1
   for update;
  if active_job is not null then raise exception 'FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING'; end if;

  next_metadata := coalesce(metadata_row.metadata, '{}'::jsonb) - 'galleryMediaIds' - 'galleryStatus' - 'galleryUpdatedAt' - 'galleryError';
  update public.listings
     set images = '[]'::jsonb, gallery_status = 'NOT_REQUESTED', gallery_job_id = null,
         gallery_requested_at = null, gallery_completed_at = null, gallery_error = null,
         gallery_total = 0, gallery_persisted_count = 0
   where id = p_listing_id;
  update public.listing_source_metadata set metadata = next_metadata where id = metadata_row.id;

  insert into public.facebook_scan_jobs (
    scan_run_id, source_scan_id, search_filter_id, status, group_snapshot,
    idempotency_key, consumer_type, job_type, priority, gallery_listing_id,
    gallery_post_id, gallery_source_url, available_at
  ) values (
    gen_random_uuid(), null, filter_id, 'queued', '[]'::jsonb,
    'gallery:' || p_listing_id::text || ':' || gen_random_uuid()::text,
    'BROWSER_EXTENSION', 'GALLERY_HYDRATION', 100, p_listing_id,
    listing_post_id, metadata_row.source_post_url, now()
  ) returning * into new_job;

  update public.listings set gallery_status = 'PENDING', gallery_job_id = new_job.id, gallery_requested_at = now(), gallery_error = null where id = p_listing_id;
  return query select p_listing_id, new_job.id, listing_post_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.request_price_radar_run_stop(p_owner_id uuid, p_run_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_run public.price_radar_runs%rowtype;
  source_queue jsonb;
  v_source_statuses jsonb;
  source_id text;
  running_source_exists boolean := false;
  queued_job_id uuid;
  stop_now boolean := false;
begin
  if p_owner_id is null or p_run_id is null then raise exception 'owner and run are required'; end if;

  select * into current_run from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id for update;
  if not found then return 'run_changed'; end if;
  if current_run.status = 'partial' and current_run.error_message = 'RADAR_STOPPED_BY_OPERATOR'
     and current_run.stop_requested_at is not null then return 'stopped'; end if;
  if current_run.status not in ('pending', 'running') then return 'not_active'; end if;

  source_queue := case when jsonb_typeof(current_run.checkpoint->'sourceQueue') = 'array'
    then current_run.checkpoint->'sourceQueue' else '[]'::jsonb end;
  v_source_statuses := case when jsonb_typeof(current_run.checkpoint->'sourceStatuses') = 'object'
    then current_run.checkpoint->'sourceStatuses' else '{}'::jsonb end;

  -- Prefer the source that is actually running. If the saved cursor is stale
  -- or points past the array, use the first unfinished source in queue order.
  -- A missing/currently completed pointer is never a reason to reject STOP.
  select q.value into source_id
    from jsonb_array_elements_text(source_queue) with ordinality as q(value, ordinal)
   where coalesce(v_source_statuses->>q.value, '') in ('running', 'pending')
   order by case when v_source_statuses->>q.value = 'running' then 0 else 1 end, q.ordinal
   limit 1;
  select exists (
    select 1 from jsonb_array_elements_text(source_queue) as q(value)
     where v_source_statuses->>q.value = 'running'
  ) into running_source_exists;

  -- Persist STOP before touching the job or checkpoint. A live source worker
  -- will acknowledge through the existing lease-fenced checkpoint RPC.
  update public.price_radar_runs r set stop_requested_at = coalesce(r.stop_requested_at, now())
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running');
  if not found then return 'run_changed'; end if;
  current_run.stop_requested_at := coalesce(current_run.stop_requested_at, now());

  -- A queued OLX reservation has no worker to acknowledge STOP. Cancel only
  -- the job belonging to this exact Radar run; never create or touch a Finder
  -- job. Its existing idempotency row remains in history for operator resume.
  if source_id = 'olx' then
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run before the OLX job was claimed'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'queued'
     returning j.id into queued_job_id;
    if queued_job_id is not null then stop_now := true; end if;
  end if;

  -- There is no source worker to acknowledge if no source is marked running.
  -- Finalize immediately in that case (including cursor==queue length with
  -- pending sources), instead of leaving an idle lease to look like a scan.
  if not running_source_exists or current_run.lease_until is null or current_run.lease_until <= now() then
    stop_now := true;
  end if;

  if stop_now then
    -- Return only actually running sources to pending. Completed and failed
    -- sources, pending work, all cursors, and all counters are preserved.
    for source_id in
      select q.value from jsonb_array_elements_text(source_queue) with ordinality as q(value, ordinal)
       where v_source_statuses->>q.value = 'running' order by q.ordinal
    loop
      v_source_statuses := jsonb_set(v_source_statuses, array[source_id], '"pending"'::jsonb, true);
      current_run.source_statuses := jsonb_set(coalesce(current_run.source_statuses, '{}'::jsonb), array[source_id], '"pending"'::jsonb, true);
    end loop;

    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'running';

    update public.price_radar_runs r set status = 'partial', error_message = 'RADAR_STOPPED_BY_OPERATOR',
      checkpoint = jsonb_set(current_run.checkpoint, '{sourceStatuses}', v_source_statuses, true),
      source_statuses = current_run.source_statuses, finished_at = now(), lease_token = null, lease_until = null
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running')
       and r.stop_requested_at is not null;
    if not found then return 'run_changed'; end if;
    return 'stopped';
  end if;

  return 'stopping';
end;
$function$

CREATE OR REPLACE FUNCTION public.reserve_source_scans(p_search_filter_id uuid, p_sources text[], p_scan_run_id uuid, p_filter_snapshot jsonb)
 RETURNS SETOF source_scans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  locked_filter_id uuid;
  existing_count integer;
begin
  if p_search_filter_id is null then
    raise exception 'search_filter_id is required';
  end if;
  if p_sources is null or array_length(p_sources, 1) is null then
    raise exception 'sources is required';
  end if;
  if p_scan_run_id is null then
    raise exception 'scan_run_id is required';
  end if;

  -- Serializes every concurrent reservation attempt for this filter: the
  -- second caller blocks here until the first caller's transaction commits
  -- or rolls back, then proceeds with a fresh read below.
  select id into locked_filter_id
    from public.search_filters
   where id = p_search_filter_id
   for update;

  if locked_filter_id is null then
    raise exception 'SEARCH_FILTER_NOT_FOUND';
  end if;

  select count(*) into existing_count
    from public.source_scans
   where search_filter_id = p_search_filter_id
     and source = any(p_sources)
     and status in ('pending', 'running');

  if existing_count > 0 then
    raise exception 'SCAN_ALREADY_RUNNING';
  end if;

  return query
    insert into public.source_scans (search_filter_id, source, status, scan_run_id, filter_snapshot)
    select p_search_filter_id, src, 'pending', p_scan_run_id, p_filter_snapshot
      from unnest(p_sources) as src
    returning *;
end;
$function$

CREATE OR REPLACE FUNCTION public.resolve_price_radar_verification_candidate(p_owner_id uuid, p_queue_id uuid, p_operator_id uuid, p_decision jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  queue_row public.price_radar_verification_queue%rowtype;
  saved_id uuid;
  price_value numeric := nullif(p_decision->>'price','')::numeric;
  area_value numeric := nullif(p_decision->>'area','')::numeric;
  rooms_value integer := nullif(p_decision->>'rooms','')::integer;
  district_value text := p_decision->>'district';
  building_value text := p_decision->>'buildingType';
  market_value text := p_decision->>'marketType';
  category_value text := p_decision->>'qualityCategory';
  renovation_value text;
  snapshot jsonb;
  decision_value jsonb;
begin
  if p_owner_id is null or p_queue_id is null or p_operator_id is distinct from p_owner_id
    or jsonb_typeof(p_decision) <> 'object' or p_decision->>'apartmentSaleConfirmed' <> 'true'
    or price_value is null or price_value <= 0 or area_value is null or area_value <= 0
    or rooms_value is null or rooms_value <= 0
    or p_decision->>'city' is distinct from 'Łódź'
    or coalesce(district_value not in ('Bałuty','Górna','Polesie','Śródmieście','Widzew'), true)
    or coalesce(building_value not in ('blok','apartamentowiec'), true)
    or coalesce(market_value not in ('primary','secondary'), true)
    or coalesce(category_value not in ('fresh_renovation','ready_high_standard'), true)
    or (category_value = 'fresh_renovation' and market_value <> 'secondary') then
    raise exception 'INVALID_PRICE_RADAR_VERIFICATION_DECISION';
  end if;
  renovation_value := case when category_value = 'fresh_renovation' then 'fresh_renovation' else 'turnkey_finish' end;

  select q.* into queue_row from public.price_radar_verification_queue q
   where q.id = p_queue_id and q.owner_id = p_owner_id and q.status in ('pending','confirmed') for update;
  if not found then raise exception 'PRICE_RADAR_VERIFICATION_CANDIDATE_NOT_FOUND'; end if;
  snapshot := queue_row.source_snapshot;
  decision_value := p_decision || jsonb_build_object('decisionAt', now(), 'decisionBy', p_operator_id);

  select l.id into saved_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = queue_row.source
     and (l.external_listing_id = queue_row.external_listing_id or l.normalized_url = queue_row.normalized_url)
   order by (l.external_listing_id = queue_row.external_listing_id) desc, l.last_seen_at desc
   limit 1 for update;

  if saved_id is null then
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description,
      price, area, price_per_sqm, rooms, city, district, building_type, market_type,
      renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, raw_payload
    ) values (
      p_owner_id, queue_row.source, queue_row.external_listing_id, queue_row.original_url, queue_row.normalized_url,
      queue_row.title, nullif(snapshot->>'description',''), price_value, area_value, price_value / area_value, rooms_value,
      p_decision->>'city', district_value, building_value, market_value, renovation_value,
      coalesce(nullif(snapshot->>'contentHash',''), md5(queue_row.source || ':' || queue_row.external_listing_id)),
      nullif(snapshot->>'crossSourceIdentity',''), nullif(snapshot->>'publishedAt','')::timestamptz,
      nullif(snapshot->>'sourceUpdatedAt','')::timestamptz, coalesce(nullif(snapshot->>'collectedAt','')::timestamptz, now()),
      jsonb_build_object('operatorVerification', decision_value, 'verificationQueueId', queue_row.id, 'sourceSnapshot', snapshot)
    ) returning id into saved_id;
  else
    update public.price_radar_listings l set
      external_listing_id = queue_row.external_listing_id, original_url = queue_row.original_url, normalized_url = queue_row.normalized_url,
      title = queue_row.title, description = nullif(snapshot->>'description',''), price = price_value, area = area_value,
      price_per_sqm = price_value / area_value, rooms = rooms_value, city = p_decision->>'city', district = district_value,
      building_type = building_value, market_type = market_value, renovation_status = renovation_value,
      content_hash = coalesce(nullif(snapshot->>'contentHash',''), l.content_hash),
      cross_source_identity = coalesce(nullif(snapshot->>'crossSourceIdentity',''), l.cross_source_identity),
      published_at = coalesce(nullif(snapshot->>'publishedAt','')::timestamptz, l.published_at),
      source_updated_at = coalesce(nullif(snapshot->>'sourceUpdatedAt','')::timestamptz, l.source_updated_at),
      collected_at = coalesce(nullif(snapshot->>'collectedAt','')::timestamptz, now()), last_seen_at = now(), status = 'active',
      raw_payload = coalesce(l.raw_payload,'{}'::jsonb) || jsonb_build_object('operatorVerification', decision_value, 'verificationQueueId', queue_row.id, 'sourceSnapshot', snapshot)
     where l.id = saved_id and l.owner_id = p_owner_id;
  end if;

  update public.price_radar_verification_queue q set status = 'confirmed', operator_decision = decision_value,
    decision_at = now(), decision_by = p_operator_id, rejected_at = null, radar_listing_id = saved_id
   where q.id = queue_row.id and q.owner_id = p_owner_id;
  return saved_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_facebook_scan_job_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_finder_olx_schedule_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT'
     or old.finder_olx_schedule_anchor is null
     or new.finder_olx_scan_interval_minutes is distinct from old.finder_olx_scan_interval_minutes
     or new.finder_olx_start_time is distinct from old.finder_olx_start_time then
    new.finder_olx_schedule_anchor := public.finder_olx_first_slot(new.finder_olx_start_time, new.finder_olx_scan_interval_minutes, now());
  elsif new.finder_olx_schedule_anchor is distinct from old.finder_olx_schedule_anchor then
    -- The anchor is durable: only a schedule change moves it.
    new.finder_olx_schedule_anchor := old.finder_olx_schedule_anchor;
  end if;
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_investment_os_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated_at = now(); return new; end; $function$

CREATE OR REPLACE FUNCTION public.set_listing_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_olx_scan_job_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_price_radar_district_queue_rejection(p_owner_id uuid, p_queue_id uuid, p_rejected boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.price_radar_district_queue q set
    status = case when p_rejected then 'rejected' else 'pending' end,
    rejected_at = case when p_rejected then now() else null end
   where q.id = p_queue_id and q.owner_id = p_owner_id and q.status in ('pending', 'rejected');
  return found;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_price_radar_listing_exclusion(p_owner_id uuid, p_listing_id uuid, p_excluded boolean, p_reason text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  identity text;
begin
  select l.cross_source_identity into identity from public.price_radar_listings l
   where l.id = p_listing_id and l.owner_id = p_owner_id for update;
  if not found then return false; end if;
  update public.price_radar_listings l set
    excluded_at = case when p_excluded then coalesce(l.excluded_at, now()) else null end,
    excluded_reason = case when p_excluded then p_reason else null end
   where l.owner_id = p_owner_id and (l.id = p_listing_id or (identity is not null and l.cross_source_identity = identity));
  return true;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_price_radar_verification_queue_rejection(p_owner_id uuid, p_queue_id uuid, p_rejected boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_owner_id is null or p_queue_id is null or p_rejected is null then raise exception 'INVALID_PRICE_RADAR_VERIFICATION_DECISION'; end if;
  update public.price_radar_verification_queue q set
    status = case when p_rejected then 'rejected' else 'pending' end,
    rejected_at = case when p_rejected then coalesce(q.rejected_at, now()) else null end
   where q.owner_id = p_owner_id and q.id = p_queue_id and q.status in ('pending','rejected');
  return found;
end;
$function$

CREATE OR REPLACE FUNCTION public.set_search_filter_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION public.terminate_price_radar_run(p_owner_id uuid, p_run_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  current_run public.price_radar_runs%rowtype;
  saved_checkpoint jsonb;
  saved_statuses jsonb;
  source_id text;
begin
  if p_owner_id is null or p_run_id is null then
    raise exception 'owner and run are required';
  end if;

  select * into current_run
    from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id
   for update;
  if not found then return 'run_changed'; end if;

  if current_run.user_terminated_at is not null then
    return 'terminated';
  end if;

  if current_run.status not in ('pending', 'running')
     and not (current_run.status = 'partial'
       and current_run.error_message = 'RADAR_STOPPED_BY_OPERATOR'
       and current_run.stop_requested_at is not null) then
    return 'not_active';
  end if;

  saved_checkpoint := current_run.checkpoint;
  saved_statuses := case
    when pg_catalog.jsonb_typeof(current_run.checkpoint->'sourceStatuses') = 'object'
      then current_run.checkpoint->'sourceStatuses'
    else coalesce(current_run.source_statuses, '{}'::jsonb)
  end;

  -- A source interrupted by this operation remains unfinished. Preserve its
  -- cursor and all other statuses/diagnostics; only running becomes pending.
  for source_id in
    select entry.key
      from pg_catalog.jsonb_each_text(saved_statuses) as entry(key, value)
     where entry.value = 'running'
  loop
    saved_statuses := pg_catalog.jsonb_set(saved_statuses, array[source_id], '"pending"'::jsonb, true);
  end loop;
  saved_checkpoint := pg_catalog.jsonb_set(saved_checkpoint, '{sourceStatuses}', saved_statuses, true);

  -- Fence only an OLX job owned by this exact Radar run. Keep the job row and
  -- result summary as history; Finder and other Radar/operator jobs are untouched.
  update public.olx_scan_jobs j
     set status = 'failed', finished_at = pg_catalog.now(), leased_until = null,
         lease_token = null, worker_id = null, heartbeat_at = pg_catalog.now(),
         error_code = 'RADAR_TERMINATED_BY_USER',
         error_message = 'Radar run terminated by its owner',
         result_summary = coalesce(j.result_summary, '{}'::jsonb)
           || pg_catalog.jsonb_build_object('termination_reason', 'user_request', 'terminated_at', pg_catalog.now())
   where j.context_type = 'price_radar'
     and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
     and j.status in ('queued', 'running');

  -- This row lock serializes against checkpoint, listing persistence,
  -- heartbeat, and OLX finalization RPCs. After this commit their existing
  -- status='running'/lease predicates reject late writes. The saved pointer is
  -- deliberately irrelevant, including currentSourceIndex == queue.length.
  update public.price_radar_runs r
     set status = 'partial',
         checkpoint = saved_checkpoint,
         source_statuses = saved_statuses,
         finished_at = pg_catalog.now(),
         lease_token = null,
         lease_until = null,
         user_terminated_at = coalesce(r.user_terminated_at, pg_catalog.now())
   where r.id = p_run_id and r.owner_id = p_owner_id
     and r.status in ('pending', 'running', 'partial')
     and r.user_terminated_at is null;
  if not found then return 'run_changed'; end if;

  return 'terminated';
end;
$function$

CREATE OR REPLACE FUNCTION public.upsert_price_radar_district_queue_candidate(p_owner_id uuid, p_candidate jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  existing public.price_radar_district_queue%rowtype;
  saved_id uuid;
begin
  select * into existing from public.price_radar_district_queue q
   where q.owner_id = p_owner_id and q.source = p_candidate->>'source' and q.external_listing_id = p_candidate->>'external_listing_id'
   for update;

  if found then
    update public.price_radar_district_queue q set
      original_url = p_candidate->>'original_url', normalized_url = p_candidate->>'normalized_url',
      title = p_candidate->>'title', description = p_candidate->>'description',
      price = (p_candidate->>'price')::numeric, area = (p_candidate->>'area')::numeric, price_per_sqm = (p_candidate->>'price_per_sqm')::numeric,
      rooms = nullif(p_candidate->>'rooms', '')::integer, city = p_candidate->>'city',
      building_type = p_candidate->>'building_type', market_type = p_candidate->>'market_type', renovation_status = p_candidate->>'renovation_status',
      content_hash = p_candidate->>'content_hash', cross_source_identity = nullif(p_candidate->>'cross_source_identity', ''),
      published_at = nullif(p_candidate->>'published_at', '')::timestamptz, source_updated_at = nullif(p_candidate->>'source_updated_at', '')::timestamptz,
      collected_at = (p_candidate->>'collected_at')::timestamptz, last_seen_at = (p_candidate->>'last_seen_at')::timestamptz,
      raw_payload = coalesce(p_candidate->'raw_payload', '{}'::jsonb),
      -- The caller (upsertPendingDistrictCandidate) already decided
      -- whether to recompute these: it passes the PRIOR row's own values
      -- back unchanged when content_hash is the same, so this is always a
      -- plain overwrite here, never a conditional skip in SQL.
      suggested_district = nullif(p_candidate->>'suggested_district', ''),
      suggestion_source = nullif(p_candidate->>'suggestion_source', ''),
      suggestion_evidence = nullif(p_candidate->>'suggestion_evidence', '')
      -- status/assigned_*/rejected_at/radar_listing_id intentionally
      -- untouched: a rescan must never silently reopen or discard a
      -- decision the operator already made.
    where q.id = existing.id
    returning q.id into saved_id;
  else
    insert into public.price_radar_district_queue (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description,
      price, area, price_per_sqm, rooms, city, building_type, market_type, renovation_status,
      content_hash, cross_source_identity, published_at, source_updated_at, collected_at, last_seen_at, raw_payload,
      suggested_district, suggestion_source, suggestion_evidence
    ) values (
      p_owner_id, p_candidate->>'source', p_candidate->>'external_listing_id', p_candidate->>'original_url', p_candidate->>'normalized_url',
      p_candidate->>'title', p_candidate->>'description', (p_candidate->>'price')::numeric, (p_candidate->>'area')::numeric, (p_candidate->>'price_per_sqm')::numeric,
      nullif(p_candidate->>'rooms', '')::integer, p_candidate->>'city', p_candidate->>'building_type', p_candidate->>'market_type', p_candidate->>'renovation_status',
      p_candidate->>'content_hash', nullif(p_candidate->>'cross_source_identity', ''), nullif(p_candidate->>'published_at', '')::timestamptz,
      nullif(p_candidate->>'source_updated_at', '')::timestamptz, (p_candidate->>'collected_at')::timestamptz, (p_candidate->>'last_seen_at')::timestamptz,
      coalesce(p_candidate->'raw_payload', '{}'::jsonb),
      nullif(p_candidate->>'suggested_district', ''), nullif(p_candidate->>'suggestion_source', ''), nullif(p_candidate->>'suggestion_evidence', '')
    ) returning id into saved_id;
  end if;
  return saved_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.upsert_price_radar_verification_candidate(p_owner_id uuid, p_candidate jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  queue_row public.price_radar_verification_queue%rowtype;
  candidate_source text := p_candidate->>'source';
  candidate_external_id text := nullif(btrim(p_candidate->>'external_listing_id'), '');
  candidate_url text := nullif(btrim(p_candidate->>'normalized_url'), '');
begin
  if p_owner_id is null or jsonb_typeof(p_candidate) <> 'object'
    or candidate_external_id is null or candidate_url is null
    or nullif(btrim(p_candidate->>'original_url'), '') is null
    or coalesce(candidate_source not in ('otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka','nieruchomosci_online','oferty_net','szybko','domy','allegro_lokalnie','official_cooperative','official_uml'), true)
    or jsonb_typeof(coalesce(p_candidate->'source_snapshot','{}'::jsonb)) <> 'object'
    or (select u.id from auth.users u where u.id = p_owner_id) is null then
    raise exception 'INVALID_PRICE_RADAR_VERIFICATION_CANDIDATE';
  end if;

  select q.* into queue_row
    from public.price_radar_verification_queue q
   where q.owner_id = p_owner_id and q.source = candidate_source
     and (q.external_listing_id = candidate_external_id or q.normalized_url = candidate_url)
   order by (q.external_listing_id = candidate_external_id) desc, q.last_seen_at desc
   limit 1 for update;

  if found then
    update public.price_radar_verification_queue q set
      external_listing_id = candidate_external_id,
      original_url = p_candidate->>'original_url', normalized_url = candidate_url,
      title = nullif(p_candidate->>'title',''), source_snapshot = coalesce(p_candidate->'source_snapshot','{}'::jsonb),
      confirmed_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'confirmed_fields','[]'::jsonb))), '{}'),
      missing_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'missing_fields','[]'::jsonb))), '{}'),
      contradictory_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'contradictory_fields','[]'::jsonb))), '{}'),
      routing_reasons = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'routing_reasons','[]'::jsonb))), '{}'),
      field_evidence = coalesce(p_candidate->'field_evidence','{}'::jsonb),
      suggested_district = nullif(p_candidate->>'suggested_district',''),
      suggestion_evidence = nullif(p_candidate->>'suggestion_evidence',''),
      last_seen_at = coalesce(nullif(p_candidate->>'last_seen_at','')::timestamptz, now())
     where q.id = queue_row.id;
    return queue_row.id;
  end if;

  insert into public.price_radar_verification_queue (
    owner_id, source, external_listing_id, original_url, normalized_url, title,
    source_snapshot, confirmed_fields, missing_fields, contradictory_fields,
    routing_reasons, field_evidence, suggested_district, suggestion_evidence,
    first_seen_at, last_seen_at
  ) values (
    p_owner_id, candidate_source, candidate_external_id, p_candidate->>'original_url', candidate_url,
    nullif(p_candidate->>'title',''), coalesce(p_candidate->'source_snapshot','{}'::jsonb),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'confirmed_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'missing_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'contradictory_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'routing_reasons','[]'::jsonb))), '{}'),
    coalesce(p_candidate->'field_evidence','{}'::jsonb), nullif(p_candidate->>'suggested_district',''),
    nullif(p_candidate->>'suggestion_evidence',''),
    coalesce(nullif(p_candidate->>'first_seen_at','')::timestamptz, now()),
    coalesce(nullif(p_candidate->>'last_seen_at','')::timestamptz, now())
  ) returning * into queue_row;
  return queue_row.id;
exception when unique_violation then
  select q.* into queue_row from public.price_radar_verification_queue q
   where q.owner_id = p_owner_id and q.source = candidate_source
     and (q.external_listing_id = candidate_external_id or q.normalized_url = candidate_url)
   order by (q.external_listing_id = candidate_external_id) desc, q.last_seen_at desc
   limit 1 for update;
  if not found then raise; end if;
  update public.price_radar_verification_queue q set last_seen_at = now() where q.id = queue_row.id;
  return queue_row.id;
end;
$function$

CREATE TRIGGER ceo_decisions_append_only BEFORE DELETE OR UPDATE ON public.ceo_decisions FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER deal_actual_outcomes_append_only BEFORE DELETE OR UPDATE ON public.deal_actual_outcomes FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER deal_evidence_append_only BEFORE DELETE OR UPDATE ON public.deal_evidence FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER deal_evidence_set_updated_at BEFORE UPDATE ON public.deal_evidence FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER deal_fact_override_confirmations_append_only BEFORE DELETE OR UPDATE ON public.deal_fact_override_confirmations FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER deal_fact_override_events_append_only BEFORE DELETE OR UPDATE ON public.deal_fact_override_events FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER deal_fact_overrides_set_updated_at BEFORE UPDATE ON public.deal_fact_overrides FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER deal_outcomes_set_updated_at BEFORE UPDATE ON public.deal_outcomes FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER director_information_requests_set_updated_at BEFORE UPDATE ON public.director_information_requests FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER director_outputs_append_only BEFORE DELETE OR UPDATE ON public.director_outputs FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER director_runs_append_only BEFORE DELETE OR UPDATE ON public.director_runs FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER director_scorecards_set_updated_at BEFORE UPDATE ON public.director_scorecards FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER evidence_conflicts_append_only BEFORE DELETE OR UPDATE ON public.evidence_conflicts FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER facebook_scan_jobs_set_updated_at BEFORE UPDATE ON public.facebook_scan_jobs FOR EACH ROW EXECUTE FUNCTION set_facebook_scan_job_updated_at();
CREATE TRIGGER listing_fact_observations_append_only BEFORE DELETE OR UPDATE ON public.listing_fact_observations FOR EACH ROW EXECUTE FUNCTION prevent_investment_history_mutation();
CREATE TRIGGER listings_set_updated_at BEFORE UPDATE ON public.listings FOR EACH ROW EXECUTE FUNCTION set_listing_updated_at();
CREATE TRIGGER market_assumptions_set_updated_at BEFORE UPDATE ON public.market_assumptions FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE TRIGGER olx_scan_jobs_block_price_radar BEFORE INSERT OR UPDATE ON public.olx_scan_jobs FOR EACH ROW EXECUTE FUNCTION block_price_radar_olx_jobs();
CREATE TRIGGER olx_scan_jobs_guard_scheduled BEFORE UPDATE ON public.olx_scan_jobs FOR EACH ROW EXECUTE FUNCTION guard_scheduled_olx_job();
CREATE TRIGGER olx_scan_jobs_set_updated_at BEFORE UPDATE ON public.olx_scan_jobs FOR EACH ROW EXECUTE FUNCTION set_olx_scan_job_updated_at();
CREATE TRIGGER search_filters_finder_olx_anchor BEFORE INSERT OR UPDATE ON public.search_filters FOR EACH ROW EXECUTE FUNCTION set_finder_olx_schedule_anchor();
CREATE TRIGGER search_filters_set_updated_at BEFORE UPDATE ON public.search_filters FOR EACH ROW EXECUTE FUNCTION set_search_filter_updated_at();
CREATE TRIGGER underwriting_settings_set_updated_at BEFORE UPDATE ON public.underwriting_settings FOR EACH ROW EXECUTE FUNCTION set_investment_os_updated_at();
CREATE POLICY finder_building_type_confirmations_operator_read ON finder_building_type_confirmations AS PERMISSIVE FOR SELECT TO authenticated USING ((COALESCE(((( SELECT auth.jwt() AS jwt) -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'operator'::text));
CREATE POLICY finder_listing_identity_decisions_read_own ON finder_listing_identity_decisions AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY finder_listing_identity_groups_read_own ON finder_listing_identity_groups AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY listing_filter_matches_select_development ON listing_filter_matches AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY listing_snapshots_delete_development ON listing_snapshots AS PERMISSIVE FOR DELETE TO anon USING (true);
CREATE POLICY listing_snapshots_insert_development ON listing_snapshots AS PERMISSIVE FOR INSERT TO anon,authenticated WITH CHECK (true);
CREATE POLICY listing_snapshots_select_development ON listing_snapshots AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY listing_snapshots_update_development ON listing_snapshots AS PERMISSIVE FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY listings_select_development ON listings AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY price_radar_district_queue_owner_select ON price_radar_district_queue AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY price_radar_listings_owner_select ON price_radar_listings AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY price_radar_runs_owner_select ON price_radar_runs AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY price_radar_settings_owner_select ON price_radar_settings AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY price_radar_verification_queue_owner_select ON price_radar_verification_queue AS PERMISSIVE FOR SELECT TO authenticated USING ((owner_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Allow read for everyone" ON properties AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY properties_select_development ON properties AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY resale_comp_price_history_select_app ON resale_comp_price_history AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY resale_comps_select_app ON resale_comps AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY search_filters_select_development ON search_filters AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY source_scans_delete_development ON source_scans AS PERMISSIVE FOR DELETE TO anon USING (true);
CREATE POLICY source_scans_insert_development ON source_scans AS PERMISSIVE FOR INSERT TO anon,authenticated WITH CHECK (true);
CREATE POLICY source_scans_select_development ON source_scans AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY source_scans_update_development ON source_scans AS PERMISSIVE FOR UPDATE TO anon,authenticated USING (true) WITH CHECK (true);
GRANT REFERENCES,TRUNCATE,INSERT,SELECT,UPDATE,TRIGGER ON TABLE public.alert_preferences TO service_role;
GRANT SELECT,INSERT,TRIGGER,REFERENCES,TRUNCATE,UPDATE ON TABLE public.alerts TO service_role;
GRANT SELECT,INSERT ON TABLE public.ceo_decisions TO service_role;
GRANT INSERT,SELECT,UPDATE,REFERENCES,TRUNCATE,TRIGGER ON TABLE public.collector_devices TO service_role;
GRANT TRUNCATE,REFERENCES,TRIGGER ON TABLE public.collector_imports TO authenticated;
GRANT REFERENCES,TRIGGER,TRUNCATE ON TABLE public.collector_imports TO service_role;
GRANT REFERENCES,TRIGGER,SELECT,UPDATE,INSERT,DELETE,TRUNCATE ON TABLE public.collector_request_nonces TO service_role;
GRANT UPDATE,INSERT,SELECT,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.collector_scan_batches TO service_role;
GRANT INSERT,SELECT ON TABLE public.deal_actual_outcomes TO service_role;
GRANT INSERT,SELECT ON TABLE public.deal_evidence TO service_role;
GRANT SELECT,INSERT ON TABLE public.deal_fact_override_confirmations TO service_role;
GRANT SELECT,INSERT ON TABLE public.deal_fact_override_events TO service_role;
GRANT INSERT,SELECT,UPDATE ON TABLE public.deal_fact_overrides TO service_role;
GRANT INSERT,SELECT,UPDATE ON TABLE public.deal_outcomes TO service_role;
GRANT UPDATE,INSERT,SELECT ON TABLE public.deals TO service_role;
GRANT INSERT,SELECT,UPDATE ON TABLE public.director_information_requests TO service_role;
GRANT INSERT,SELECT ON TABLE public.director_outputs TO service_role;
GRANT INSERT,SELECT ON TABLE public.director_runs TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.director_scorecards TO service_role;
GRANT SELECT,INSERT ON TABLE public.evidence_conflicts TO service_role;
GRANT REFERENCES,INSERT,SELECT,UPDATE,DELETE,TRUNCATE,TRIGGER ON TABLE public.facebook_group_discovery_sessions TO service_role;
GRANT REFERENCES,TRIGGER,INSERT,SELECT,UPDATE,TRUNCATE ON TABLE public.facebook_scan_jobs TO service_role;
GRANT DELETE,TRIGGER,REFERENCES,INSERT,TRUNCATE ON TABLE public.facebook_worker_nonces TO service_role;
GRANT SELECT ON TABLE public.finder_building_type_confirmations TO authenticated;
GRANT TRUNCATE,REFERENCES,TRIGGER,SELECT,INSERT,DELETE,UPDATE ON TABLE public.finder_building_type_confirmations TO service_role;
GRANT SELECT ON TABLE public.finder_listing_identity_decisions TO authenticated;
GRANT REFERENCES,INSERT,SELECT,UPDATE,DELETE,TRUNCATE,TRIGGER ON TABLE public.finder_listing_identity_decisions TO service_role;
GRANT SELECT ON TABLE public.finder_listing_identity_groups TO authenticated;
GRANT INSERT,SELECT,REFERENCES,TRIGGER,DELETE,UPDATE,TRUNCATE ON TABLE public.finder_listing_identity_groups TO service_role;
GRANT SELECT,TRIGGER,REFERENCES,INSERT,TRUNCATE ON TABLE public.finder_olx_slots TO service_role;
GRANT TRUNCATE,INSERT,SELECT,DELETE,REFERENCES,TRIGGER ON TABLE public.gallery_request_traces TO service_role;
GRANT INSERT,SELECT ON TABLE public.listing_fact_observations TO service_role;
GRANT TRUNCATE,UPDATE,DELETE,TRIGGER,REFERENCES,INSERT,SELECT ON TABLE public.listing_filter_match_audit TO service_role;
GRANT TRIGGER,REFERENCES,TRUNCATE,SELECT ON TABLE public.listing_filter_matches TO anon;
GRANT TRUNCATE,TRIGGER,REFERENCES,SELECT ON TABLE public.listing_filter_matches TO authenticated;
GRANT UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,INSERT,SELECT ON TABLE public.listing_filter_matches TO service_role;
GRANT DELETE,TRIGGER,SELECT,INSERT,REFERENCES,TRUNCATE,UPDATE ON TABLE public.listing_snapshots TO anon;
GRANT INSERT,TRIGGER,REFERENCES,TRUNCATE,SELECT ON TABLE public.listing_snapshots TO authenticated;
GRANT SELECT,TRIGGER,TRUNCATE,REFERENCES,INSERT ON TABLE public.listing_snapshots TO service_role;
GRANT REFERENCES,TRIGGER,TRUNCATE ON TABLE public.listing_source_metadata TO authenticated;
GRANT INSERT,SELECT,UPDATE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.listing_source_metadata TO service_role;
GRANT TRIGGER,SELECT,TRUNCATE,REFERENCES ON TABLE public.listings TO anon;
GRANT TRIGGER,SELECT,TRUNCATE,REFERENCES ON TABLE public.listings TO authenticated;
GRANT TRIGGER,SELECT,UPDATE,INSERT,DELETE,TRUNCATE,REFERENCES ON TABLE public.listings TO service_role;
GRANT UPDATE,INSERT,SELECT ON TABLE public.market_assumptions TO service_role;
GRANT SELECT,TRIGGER,REFERENCES,TRUNCATE,UPDATE ON TABLE public.olx_automation_control TO service_role;
GRANT SELECT,TRUNCATE,TRIGGER,REFERENCES ON TABLE public.olx_cloud_budget TO service_role;
GRANT UPDATE,INSERT,SELECT,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.olx_scan_jobs TO service_role;
GRANT TRIGGER,INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES ON TABLE public.olx_worker_nonces TO service_role;
GRANT SELECT ON TABLE public.price_radar_district_queue TO authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.price_radar_district_queue TO service_role;
GRANT SELECT ON TABLE public.price_radar_listings TO authenticated;
GRANT TRIGGER,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,INSERT ON TABLE public.price_radar_listings TO service_role;
GRANT SELECT ON TABLE public.price_radar_runs TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.price_radar_runs TO service_role;
GRANT SELECT ON TABLE public.price_radar_settings TO authenticated;
GRANT TRIGGER,INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES ON TABLE public.price_radar_settings TO service_role;
GRANT SELECT ON TABLE public.price_radar_verification_queue TO authenticated;
GRANT SELECT,INSERT,UPDATE,TRIGGER,REFERENCES,TRUNCATE,DELETE ON TABLE public.price_radar_verification_queue TO service_role;
GRANT TRIGGER,REFERENCES,TRUNCATE,SELECT ON TABLE public.properties TO anon;
GRANT SELECT,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.properties TO authenticated;
GRANT TRUNCATE,REFERENCES,TRIGGER,DELETE,UPDATE,SELECT,INSERT ON TABLE public.properties TO service_role;
GRANT UPDATE,SELECT,INSERT,TRIGGER,REFERENCES,TRUNCATE ON TABLE public.push_subscriptions TO service_role;
GRANT TRUNCATE,SELECT,TRIGGER,REFERENCES ON TABLE public.resale_comp_price_history TO anon;
GRANT REFERENCES,SELECT,TRIGGER,TRUNCATE ON TABLE public.resale_comp_price_history TO authenticated;
GRANT TRUNCATE,DELETE,SELECT,UPDATE,INSERT,TRIGGER,REFERENCES ON TABLE public.resale_comp_price_history TO service_role;
GRANT REFERENCES,SELECT,TRUNCATE,TRIGGER ON TABLE public.resale_comps TO anon;
GRANT TRUNCATE,SELECT,TRIGGER,REFERENCES ON TABLE public.resale_comps TO authenticated;
GRANT SELECT,DELETE,TRIGGER,REFERENCES,TRUNCATE,INSERT,UPDATE ON TABLE public.resale_comps TO service_role;
GRANT REFERENCES,TRIGGER,TRUNCATE,SELECT ON TABLE public.search_filters TO anon;
GRANT TRUNCATE,REFERENCES,TRIGGER,SELECT ON TABLE public.search_filters TO authenticated;
GRANT DELETE,REFERENCES,TRIGGER,TRUNCATE,UPDATE,SELECT,INSERT ON TABLE public.search_filters TO service_role;
GRANT UPDATE,TRUNCATE,REFERENCES,INSERT,TRIGGER,DELETE,SELECT ON TABLE public.source_scans TO anon;
GRANT SELECT,UPDATE,INSERT,TRIGGER,REFERENCES,TRUNCATE ON TABLE public.source_scans TO authenticated;
GRANT SELECT,TRIGGER,REFERENCES,TRUNCATE,UPDATE,INSERT ON TABLE public.source_scans TO service_role;
GRANT UPDATE,INSERT,SELECT ON TABLE public.underwriting_settings TO service_role;
GRANT REFERENCES,UPDATE,SELECT,INSERT,TRIGGER,TRUNCATE ON TABLE public.watched_facebook_groups TO service_role;
REVOKE ALL ON FUNCTION apply_confirmed_property_group_review_decision(uuid,text,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION apply_confirmed_property_group_review_decision(uuid,text,text,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION apply_listing_review_decision(uuid,text,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION apply_listing_review_decision(uuid,text,text,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION assign_price_radar_district_queue_candidate(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION assign_price_radar_district_queue_candidate(uuid,uuid,text,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION block_price_radar_olx_jobs() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION block_price_radar_olx_jobs() TO PUBLIC;
REVOKE ALL ON FUNCTION checkpoint_price_radar_run(uuid,uuid,uuid,jsonb,jsonb,integer,integer,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION checkpoint_price_radar_run(uuid,uuid,uuid,jsonb,jsonb,integer,integer,text,text,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_facebook_scan_job(text,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_facebook_scan_job(text,integer,text) TO service_role;
REVOKE ALL ON FUNCTION claim_finder_scan_source(timestamp with time zone,timestamp with time zone,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_finder_scan_source(timestamp with time zone,timestamp with time zone,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_olx_scan_job(text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_olx_scan_job(text,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_olx_scan_job_selective(text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_olx_scan_job_selective(text,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_price_radar_run(uuid,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_price_radar_run(uuid,jsonb,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_scheduled_finder_olx_job(text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_scheduled_finder_olx_job(text,integer) TO service_role;
REVOKE ALL ON FUNCTION claim_scheduled_finder_olx_job(text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION claim_scheduled_finder_olx_job(text,integer,jsonb) TO service_role;
REVOKE ALL ON FUNCTION cleanup_listing_visibility_lifecycle(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION cleanup_listing_visibility_lifecycle(timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION clear_facebook_watcher_history_atomic() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION clear_facebook_watcher_history_atomic() TO service_role;
REVOKE ALL ON FUNCTION confirm_investment_override(uuid,uuid,text,text,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION confirm_investment_override(uuid,uuid,text,text,text,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION enqueue_facebook_gallery_job(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION enqueue_facebook_gallery_job(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION enqueue_scheduled_finder_olx_job(uuid,uuid,text,jsonb,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION enqueue_scheduled_finder_olx_job(uuid,uuid,text,jsonb,integer,boolean) TO service_role;
REVOKE ALL ON FUNCTION expire_stale_scheduled_finder_olx_jobs() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION expire_stale_scheduled_finder_olx_jobs() TO service_role;
REVOKE ALL ON FUNCTION finalize_price_radar_olx_job(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer,integer,text,text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION finalize_price_radar_olx_job(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb,integer,integer,text,text,text,jsonb,text,text) TO service_role;
REVOKE ALL ON FUNCTION finder_olx_first_slot(time without time zone,integer,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION finder_olx_first_slot(time without time zone,integer,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION finder_olx_slot_window(timestamp without time zone,integer,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION finder_olx_slot_window(timestamp without time zone,integer,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION get_facebook_watcher_history_summary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION get_facebook_watcher_history_summary() TO service_role;
REVOKE ALL ON FUNCTION guard_scheduled_olx_job() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION heartbeat_price_radar_olx_job(uuid,text,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heartbeat_price_radar_olx_job(uuid,text,uuid,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION manage_finder_listing_identity(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION manage_finder_listing_identity(uuid,uuid,text,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION mark_investment_deal_stale_cas(uuid,integer,text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION mark_investment_deal_stale_cas(uuid,integer,text[]) TO service_role;
REVOKE ALL ON FUNCTION olx_cloud_budget_today(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION olx_cloud_budget_today(timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION persist_investment_deal_cas(jsonb,integer,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION persist_investment_deal_cas(jsonb,integer,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION persist_price_radar_listing(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION persist_price_radar_listing(uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION prevent_investment_history_mutation() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION prevent_investment_history_mutation() TO service_role;
REVOKE ALL ON FUNCTION reconcile_canonical_listing_decision(uuid,uuid,text,jsonb,jsonb,text,text,uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION reconcile_canonical_listing_decision(uuid,uuid,text,jsonb,jsonb,text,text,uuid,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION renew_facebook_scan_job(uuid,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION renew_facebook_scan_job(uuid,text,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION repair_facebook_gallery_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION repair_facebook_gallery_job(uuid) TO service_role;
REVOKE ALL ON FUNCTION request_price_radar_run_stop(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION request_price_radar_run_stop(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION reserve_source_scans(uuid,text[],uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION reserve_source_scans(uuid,text[],uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION resolve_price_radar_verification_candidate(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION resolve_price_radar_verification_candidate(uuid,uuid,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION set_facebook_scan_job_updated_at() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_facebook_scan_job_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION set_finder_olx_schedule_anchor() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_finder_olx_schedule_anchor() TO PUBLIC;
REVOKE ALL ON FUNCTION set_investment_os_updated_at() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_investment_os_updated_at() TO service_role;
REVOKE ALL ON FUNCTION set_listing_updated_at() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_listing_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION set_olx_scan_job_updated_at() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_olx_scan_job_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION set_price_radar_district_queue_rejection(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_price_radar_district_queue_rejection(uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION set_price_radar_listing_exclusion(uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_price_radar_listing_exclusion(uuid,uuid,boolean,text) TO service_role;
REVOKE ALL ON FUNCTION set_price_radar_verification_queue_rejection(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_price_radar_verification_queue_rejection(uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION set_search_filter_updated_at() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION set_search_filter_updated_at() TO PUBLIC;
REVOKE ALL ON FUNCTION terminate_price_radar_run(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION terminate_price_radar_run(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION upsert_price_radar_district_queue_candidate(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION upsert_price_radar_district_queue_candidate(uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION upsert_price_radar_verification_candidate(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION upsert_price_radar_verification_candidate(uuid,jsonb) TO service_role;
