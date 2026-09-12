#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 emit|apply|assert" >&2
  exit 64
}

emit_baseline() {
  cat <<'SQL'
-- Historical public.properties baseline reconstructed from Production schema proof.
-- Ephemeral CI only: never copy this file into repository migrations.
CREATE TABLE public.properties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
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
  CONSTRAINT properties_pkey PRIMARY KEY (id)
);
SQL
}

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required for ephemeral properties baseline $1." >&2
    exit 1
  fi
}

apply_baseline() {
  require_database_url "application"
  emit_baseline | psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q
  echo "Historical properties baseline applied to disposable database only."
}

assert_equivalence() {
  require_database_url "verification"

  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE
  expected record;
  actual record;
  actual_count integer;
  definition text;
  index_definition text;
BEGIN
  IF to_regclass('public.properties') IS NULL THEN
    RAISE EXCEPTION 'PROPERTIES_EQUIVALENCE: public.properties is missing after replay';
  END IF;

  FOR expected IN
    SELECT *
    FROM (VALUES
      (1, 'id', 'uuid', 'uuid', 'NO', 'gen_random_uuid()'),
      (2, 'created_at', 'timestamp with time zone', 'timestamptz', 'YES', 'now()'),
      (3, 'title', 'text', 'text', 'NO', NULL::text),
      (4, 'address', 'text', 'text', 'YES', NULL::text),
      (5, 'city', 'text', 'text', 'YES', NULL::text),
      (6, 'price', 'numeric', 'numeric', 'YES', NULL::text),
      (7, 'area', 'numeric', 'numeric', 'YES', NULL::text),
      (8, 'rooms', 'integer', 'int4', 'YES', NULL::text),
      (9, 'floor', 'integer', 'int4', 'YES', NULL::text),
      (10, 'building_floors', 'integer', 'int4', 'YES', NULL::text),
      (11, 'year_built', 'integer', 'int4', 'YES', NULL::text),
      (12, 'status', 'text', 'text', 'YES', '''new''::text'),
      (13, 'notes', 'text', 'text', 'YES', NULL::text),
      (14, 'building_type', 'text', 'text', 'YES', NULL::text),
      (15, 'ownership', 'text', 'text', 'YES', NULL::text),
      (16, 'rent', 'numeric', 'numeric', 'YES', NULL::text),
      (17, 'district', 'text', 'text', 'YES', NULL::text),
      (18, 'original_url', 'text', 'text', 'YES', NULL::text),
      (19, 'source', 'text', 'text', 'YES', NULL::text),
      (20, 'images', 'jsonb', 'jsonb', 'NO', '''[]''::jsonb'),
      (21, 'listing_id', 'uuid', 'uuid', 'YES', NULL::text),
      (22, 'flip_score', 'numeric', 'numeric', 'YES', NULL::text),
      (23, 'ai_analysis', 'jsonb', 'jsonb', 'YES', NULL::text),
      (24, 'market_intelligence', 'jsonb', 'jsonb', 'YES', NULL::text),
      (25, 'estimated_after_renovation_price', 'numeric', 'numeric', 'YES', NULL::text),
      (26, 'estimated_after_renovation_price_per_sqm', 'numeric', 'numeric', 'YES', NULL::text),
      (27, 'comparable_count', 'integer', 'int4', 'YES', NULL::text),
      (28, 'market_percentile', 'numeric', 'numeric', 'YES', NULL::text),
      (29, 'recommended_max_price', 'numeric', 'numeric', 'YES', NULL::text),
      (30, 'negotiation_target', 'numeric', 'numeric', 'YES', NULL::text),
      (31, 'purchase_decision', 'text', 'text', 'YES', NULL::text),
      (32, 'target_profit', 'numeric', 'numeric', 'YES', NULL::text),
      (33, 'target_roi', 'numeric', 'numeric', 'YES', NULL::text),
      (34, 'calculator_data', 'jsonb', 'jsonb', 'YES', NULL::text),
      (35, 'analysis_completed_at', 'timestamp with time zone', 'timestamptz', 'YES', NULL::text),
      (36, 'normalized_url', 'text', 'text', 'YES', NULL::text),
      (37, 'external_listing_id', 'text', 'text', 'YES', NULL::text),
      (38, 'investment_analysis', 'jsonb', 'jsonb', 'YES', NULL::text),
      (39, 'purchase_tax', 'numeric', 'numeric', 'YES', NULL::text),
      (40, 'notary_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (41, 'purchase_commission', 'numeric', 'numeric', 'YES', NULL::text),
      (42, 'renovation_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (43, 'furnishing_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (44, 'reserve_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (45, 'expected_sale_price', 'numeric', 'numeric', 'YES', NULL::text),
      (46, 'sale_commission', 'numeric', 'numeric', 'YES', NULL::text),
      (47, 'tax_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (48, 'total_cost', 'numeric', 'numeric', 'YES', NULL::text),
      (49, 'revenue', 'numeric', 'numeric', 'YES', NULL::text),
      (50, 'profit', 'numeric', 'numeric', 'YES', NULL::text),
      (51, 'roi', 'numeric', 'numeric', 'YES', NULL::text),
      (52, 'margin', 'numeric', 'numeric', 'YES', NULL::text),
      (53, 'total_floors', 'integer', 'int4', 'YES', NULL::text)
    ) AS e(ordinal_position, column_name, data_type, udt_name, is_nullable, column_default)
  LOOP
    SELECT ordinal_position, column_name, data_type, udt_name, is_nullable,
           column_default, is_identity, is_generated
      INTO actual
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'properties'
        AND ordinal_position = expected.ordinal_position;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROPERTIES_EQUIVALENCE: missing column at ordinal % (expected %)', expected.ordinal_position, expected.column_name;
    END IF;

    IF actual.column_name <> expected.column_name
       OR actual.data_type <> expected.data_type
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
       OR actual.is_identity <> 'NO'
       OR actual.is_generated <> 'NEVER'
       OR COALESCE(replace(replace(actual.column_default, 'pg_catalog.', ''), ' ', ''), '')
          IS DISTINCT FROM COALESCE(replace(replace(expected.column_default, 'pg_catalog.', ''), ' ', ''), '') THEN
      RAISE EXCEPTION
        'PROPERTIES_EQUIVALENCE: ordinal % differs; expected %/%/%/%/%, actual %/%/%/%/%',
        expected.ordinal_position, expected.column_name, expected.data_type, expected.udt_name, expected.is_nullable, expected.column_default,
        actual.column_name, actual.data_type, actual.udt_name, actual.is_nullable, actual.column_default;
    END IF;
  END LOOP;

  SELECT count(*) INTO actual_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'properties';
  IF actual_count <> 53 THEN
    RAISE EXCEPTION 'PROPERTIES_EQUIVALENCE: expected 53 columns, found %', actual_count;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_pkey';
  IF definition <> 'PRIMARY KEY (id)' THEN
    RAISE EXCEPTION 'PROPERTIES_CONSTRAINT_EQUIVALENCE: properties_pkey mismatch: %', definition;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_listing_id_fkey';
  IF definition IS NULL OR definition NOT ILIKE 'FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL' THEN
    RAISE EXCEPTION 'PROPERTIES_CONSTRAINT_EQUIVALENCE: properties_listing_id_fkey mismatch: %', definition;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_comparable_count_nonnegative';
  IF definition IS NULL OR definition NOT ILIKE '%comparable_count%' OR definition NOT ILIKE '%IS NULL%' OR definition NOT LIKE '%>= 0%' THEN
    RAISE EXCEPTION 'PROPERTIES_CONSTRAINT_EQUIVALENCE: comparable_count check mismatch: %', definition;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_purchase_decision_check';
  IF definition IS NULL OR definition NOT ILIKE '%purchase_decision%' OR definition NOT ILIKE '%buy%' OR definition NOT ILIKE '%negotiate%' OR definition NOT ILIKE '%reject%' THEN
    RAISE EXCEPTION 'PROPERTIES_CONSTRAINT_EQUIVALENCE: purchase_decision check mismatch: %', definition;
  END IF;

  FOR expected IN
    SELECT *
    FROM (VALUES
      ('properties_pkey', true, '(id)', NULL::text),
      ('properties_listing_id_idx', false, '(listing_id)', NULL::text),
      ('properties_normalized_url_idx', false, '(normalized_url)', 'normalized_url IS NOT NULL'),
      ('properties_original_url_idx', false, '(original_url)', 'original_url IS NOT NULL'),
      ('properties_source_external_listing_id_key', true, '(source, external_listing_id)', 'source IS NOT NULL')
    ) AS e(indexname, is_unique, key_expression, predicate_fragment)
  LOOP
    SELECT indexdef INTO index_definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'properties' AND indexname = expected.indexname;
    IF index_definition IS NULL
       OR (expected.is_unique AND index_definition NOT ILIKE 'CREATE UNIQUE INDEX%')
       OR (NOT expected.is_unique AND index_definition ILIKE 'CREATE UNIQUE INDEX%')
       OR index_definition NOT LIKE '%' || expected.key_expression || '%'
       OR (expected.predicate_fragment IS NOT NULL AND index_definition NOT ILIKE '%' || expected.predicate_fragment || '%') THEN
      RAISE EXCEPTION 'PROPERTIES_INDEX_EQUIVALENCE: % mismatch: %', expected.indexname, index_definition;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'properties'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'PROPERTIES_RLS_EQUIVALENCE: expected enabled and not forced';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'properties'
      AND policyname = 'properties_select_development'
      AND cmd = 'SELECT'
      AND roles @> ARRAY['anon'::name, 'authenticated'::name]
      AND cardinality(roles) = 2
      AND qual IN ('true', '(true)')
      AND with_check IS NULL
  ) THEN RAISE EXCEPTION 'PROPERTIES_POLICY_EQUIVALENCE: properties_select_development mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'properties'
      AND policyname = 'properties_insert_development'
      AND cmd = 'INSERT' AND roles = ARRAY['anon'::name]
      AND qual IS NULL AND with_check IN ('true', '(true)')
  ) THEN RAISE EXCEPTION 'PROPERTIES_POLICY_EQUIVALENCE: properties_insert_development mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'properties'
      AND policyname = 'properties_update_development'
      AND cmd = 'UPDATE' AND roles = ARRAY['anon'::name]
      AND qual IN ('true', '(true)') AND with_check IN ('true', '(true)')
  ) THEN RAISE EXCEPTION 'PROPERTIES_POLICY_EQUIVALENCE: properties_update_development mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'properties'
      AND policyname = 'properties_delete_development'
      AND cmd = 'DELETE' AND roles = ARRAY['anon'::name]
      AND qual IN ('true', '(true)') AND with_check IS NULL
  ) THEN RAISE EXCEPTION 'PROPERTIES_POLICY_EQUIVALENCE: properties_delete_development mismatch'; END IF;

  -- Production proof names this additional policy. Its historical definition is
  -- not reconstructed here, so its absence is a fail-closed migration-history mismatch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'properties'
      AND policyname = 'Allow read for everyone'
  ) THEN RAISE EXCEPTION 'PROPERTIES_POLICY_EQUIVALENCE: production policy "Allow read for everyone" is absent from replay'; END IF;
END
$$;

SELECT ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'properties'
ORDER BY ordinal_position;

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.properties'::regclass
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'properties'
ORDER BY indexname;

SELECT policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'properties'
ORDER BY policyname;
SQL

  echo "Historical properties schema equivalence: PASS"
}

case "${1:-}" in
  emit) emit_baseline ;;
  apply) apply_baseline ;;
  assert) assert_equivalence ;;
  *) usage ;;
esac
