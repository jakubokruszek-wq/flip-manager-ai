-- Run manually in Supabase after 20260803120000_add_property_investment_analysis.sql.
-- Completes the persisted CRM snapshot used by POST /api/properties/import-from-finder.
begin;

alter table public.properties
  add column if not exists normalized_url text,
  add column if not exists external_listing_id text,
  add column if not exists investment_analysis jsonb,
  add column if not exists purchase_tax numeric,
  add column if not exists notary_cost numeric,
  add column if not exists purchase_commission numeric,
  add column if not exists renovation_cost numeric,
  add column if not exists furnishing_cost numeric,
  add column if not exists reserve_cost numeric,
  add column if not exists expected_sale_price numeric,
  add column if not exists sale_commission numeric,
  add column if not exists tax_cost numeric,
  add column if not exists total_cost numeric,
  add column if not exists revenue numeric,
  add column if not exists profit numeric,
  add column if not exists roi numeric,
  add column if not exists margin numeric;

create index if not exists properties_original_url_idx
  on public.properties (original_url)
  where original_url is not null;

create index if not exists properties_normalized_url_idx
  on public.properties (normalized_url)
  where normalized_url is not null;

create unique index if not exists properties_source_external_listing_id_key
  on public.properties (source, external_listing_id)
  where source is not null and external_listing_id is not null;

commit;
