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
  if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?://[^/@?#]*@?(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/[^?#]*$ ]]; then
    echo "Refusing non-loopback DATABASE_URL for ephemeral properties baseline $1." >&2
    exit 1
  fi
  for name in PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE; do
    if [[ -n "${!name:-}" ]]; then
      echo "Refusing PostgreSQL connection override $name for ephemeral properties baseline $1." >&2
      exit 1
    fi
  done
}

apply_baseline() {
  require_database_url "application"
  emit_baseline | psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q
  echo "Historical properties baseline applied to disposable database only."
}

assert_equivalence() {
  require_database_url "verification"
  local drift_present
  drift_present="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAt -c \
    "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='properties' AND policyname='Allow read for everyone');")"
  echo "KNOWN PRODUCTION DRIFT: policy=\"Allow read for everyone\"; origin=UNKNOWN; present_in_repo_migrations=NO; present_in_production=YES (supplied Production proof); present_in_replay=$drift_present; semantic_overlap_with=properties_select_development; effective_access_expansion=CURRENTLY NONE; cleanup_decision=DEFERRED"

  assert_category() {
    local category="$1"
    local sql
    sql="$(cat)"
    if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f - <<< "$sql"; then
      if [[ "$category" == "CANONICAL POLICIES" ]]; then
        echo "CANONICAL POLICIES: PASS"
      else
        echo "PROPERTIES $category: PASS"
      fi
    else
      if [[ "$category" == "CANONICAL POLICIES" ]]; then
        echo "CANONICAL POLICIES: FAIL" >&2
      else
        echo "PROPERTIES $category: FAIL" >&2
      fi
      exit 1
    fi
  }

  assert_category COLUMNS <<'SQL'
DO $$
DECLARE expected record; actual record; actual_count integer;
BEGIN
  IF to_regclass('public.properties') IS NULL THEN
    RAISE EXCEPTION 'public.properties is missing after replay';
  END IF;
  FOR expected IN
    SELECT * FROM (VALUES
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
      WHERE table_schema = 'public' AND table_name = 'properties'
        AND ordinal_position = expected.ordinal_position;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing column at ordinal % (expected %)', expected.ordinal_position, expected.column_name;
    END IF;
    IF actual.column_name <> expected.column_name
       OR actual.data_type <> expected.data_type
       OR actual.udt_name <> expected.udt_name
       OR actual.is_nullable <> expected.is_nullable
       OR actual.is_identity <> 'NO'
       OR actual.is_generated <> 'NEVER'
       OR COALESCE(btrim(actual.column_default), '')
          IS DISTINCT FROM COALESCE(btrim(expected.column_default), '') THEN
      RAISE EXCEPTION 'ordinal % expected %/%/%/%/%; got %/%/%/%/%',
        expected.ordinal_position, expected.column_name, expected.data_type, expected.udt_name, expected.is_nullable, expected.column_default,
        actual.column_name, actual.data_type, actual.udt_name, actual.is_nullable, actual.column_default;
    END IF;
  END LOOP;
  SELECT count(*) INTO actual_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'properties';
  IF actual_count <> 53 THEN RAISE EXCEPTION 'expected exactly 53 columns, found %', actual_count; END IF;
END
$$;
SQL

  assert_category CONSTRAINTS <<'SQL'
DO $$
DECLARE actual_count integer; definition text; fk record;
BEGIN
  SELECT count(*) INTO actual_count FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass;
  IF actual_count <> 4 THEN RAISE EXCEPTION 'expected exactly 4 properties constraints, found %', actual_count; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.properties'::regclass
       AND (NOT convalidated OR condeferrable OR condeferred)) THEN
    RAISE EXCEPTION 'all four properties constraints must be validated and non-deferrable';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_pkey';
  IF definition IS DISTINCT FROM 'PRIMARY KEY (id)' OR NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid='public.properties'::regclass
         AND conname='properties_pkey' AND contype='p') THEN
    RAISE EXCEPTION 'properties_pkey mismatch: %', definition;
  END IF;

  SELECT * INTO fk FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_listing_id_fkey';
  IF NOT FOUND OR fk.contype <> 'f' OR NOT fk.convalidated OR fk.condeferrable OR fk.condeferred
     OR fk.conkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.properties'::regclass AND attname='listing_id')]::smallint[]
     OR fk.confrelid IS DISTINCT FROM 'public.listings'::regclass
     OR fk.confkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.listings'::regclass AND attname='id')]::smallint[]
     OR fk.confdeltype <> 'n' OR fk.confupdtype <> 'a' OR fk.confmatchtype <> 's' THEN
    RAISE EXCEPTION 'properties_listing_id_fkey mismatch: %', pg_get_constraintdef(fk.oid);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_comparable_count_nonnegative';
  IF definition IS DISTINCT FROM 'CHECK (((comparable_count IS NULL) OR (comparable_count >= 0)))' OR NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid='public.properties'::regclass
         AND conname='properties_comparable_count_nonnegative' AND contype='c') THEN
    RAISE EXCEPTION 'properties_comparable_count_nonnegative mismatch: %', definition;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_purchase_decision_check';
  IF definition IS DISTINCT FROM
       'CHECK (((purchase_decision IS NULL) OR (purchase_decision = ANY (ARRAY[''buy''::text, ''negotiate''::text, ''reject''::text]))))' OR NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid='public.properties'::regclass
         AND conname='properties_purchase_decision_check' AND contype='c') THEN
    RAISE EXCEPTION 'properties_purchase_decision_check mismatch: %', definition;
  END IF;
END
$$;
SQL

  assert_category INDEXES <<'SQL'
DO $$
DECLARE expected record; actual record; actual_count integer; normalized_predicate text;
        actual_keys text[]; key_number integer;
BEGIN
  SELECT count(*) INTO actual_count FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'properties';
  IF actual_count <> 5 THEN RAISE EXCEPTION 'expected exactly 5 properties indexes, found %', actual_count; END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('properties_pkey', true, true, ARRAY['id']::text[], NULL::text),
      ('properties_listing_id_idx', false, false, ARRAY['listing_id']::text[], 'listing_idisnotnull'),
      ('properties_normalized_url_idx', false, false, ARRAY['normalized_url']::text[], 'normalized_urlisnotnull'),
      ('properties_original_url_idx', false, false, ARRAY['original_url']::text[], 'original_urlisnotnull'),
      ('properties_source_external_listing_id_key', true, false, ARRAY['source','external_listing_id']::text[], 'sourceisnotnullandexternal_listing_idisnotnull')
    ) AS e(indexname, is_unique, is_primary, expected_keys, expected_predicate)
  LOOP
    SELECT pg_indexes.indexdef, i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
           i.indnkeyatts, i.indnatts, am.amname,
           CASE WHEN i.indpred IS NULL THEN NULL
             ELSE regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)), '[()[:space:]]', '', 'g')
           END AS normalized_predicate
      INTO actual
      FROM pg_indexes
      JOIN pg_class idx ON idx.relname = pg_indexes.indexname
      JOIN pg_namespace idx_ns ON idx_ns.oid = idx.relnamespace AND idx_ns.nspname = pg_indexes.schemaname
      JOIN pg_index i ON i.indexrelid = idx.oid
      JOIN pg_am am ON am.oid = idx.relam
      WHERE pg_indexes.schemaname = 'public' AND pg_indexes.tablename = 'properties'
        AND pg_indexes.indexname = expected.indexname;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing index %', expected.indexname; END IF;
    actual_keys := ARRAY[]::text[];
    FOR key_number IN 1..actual.indnkeyatts LOOP
      actual_keys := array_append(actual_keys, pg_get_indexdef(
        (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = expected.indexname), key_number, true));
    END LOOP;
    IF actual.indisunique IS DISTINCT FROM expected.is_unique
       OR actual.indisprimary IS DISTINCT FROM expected.is_primary
       OR actual.indisvalid IS DISTINCT FROM true OR actual.indisready IS DISTINCT FROM true
       OR actual.indnkeyatts <> cardinality(expected.expected_keys)
       OR actual.indnatts <> cardinality(expected.expected_keys)
       OR actual.amname <> 'btree'
       OR actual_keys IS DISTINCT FROM expected.expected_keys
       OR actual.normalized_predicate IS DISTINCT FROM expected.expected_predicate THEN
      RAISE EXCEPTION 'index % mismatch: definition %, normalized predicate %',
        expected.indexname, actual.indexdef, actual.normalized_predicate;
    END IF;
  END LOOP;
END
$$;
SQL

  assert_category RLS <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'properties'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
  ) THEN RAISE EXCEPTION 'expected RLS enabled=true and forced=false'; END IF;
END
$$;
SQL

  assert_category "CANONICAL POLICIES" <<'SQL'
DO $$
DECLARE policy_count integer; p record;
BEGIN
  SELECT count(*) INTO policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'properties';
  IF policy_count <> 4 THEN RAISE EXCEPTION 'expected exactly four repository policies, found %', policy_count; END IF;

  SELECT * INTO p FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties'
    AND policyname = 'properties_select_development';
  IF NOT FOUND OR p.permissive <> 'PERMISSIVE' OR p.cmd <> 'SELECT'
     OR cardinality(p.roles) <> 2 OR NOT (p.roles @> ARRAY['anon'::name, 'authenticated'::name])
     OR replace(replace(COALESCE(p.qual, ''), '(', ''), ')', '') <> 'true' OR p.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'properties_select_development role/cmd/qual/with_check mismatch';
  END IF;

  SELECT * INTO p FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties'
    AND policyname = 'properties_insert_development';
  IF NOT FOUND OR p.permissive <> 'PERMISSIVE' OR p.cmd <> 'INSERT'
     OR p.roles <> ARRAY['anon'::name] OR p.qual IS NOT NULL
     OR replace(replace(COALESCE(p.with_check, ''), '(', ''), ')', '') <> 'true' THEN
    RAISE EXCEPTION 'properties_insert_development role/cmd/qual/with_check mismatch';
  END IF;

  SELECT * INTO p FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties'
    AND policyname = 'properties_update_development';
  IF NOT FOUND OR p.permissive <> 'PERMISSIVE' OR p.cmd <> 'UPDATE'
     OR p.roles <> ARRAY['anon'::name]
     OR replace(replace(COALESCE(p.qual, ''), '(', ''), ')', '') <> 'true'
     OR replace(replace(COALESCE(p.with_check, ''), '(', ''), ')', '') <> 'true' THEN
    RAISE EXCEPTION 'properties_update_development role/cmd/qual/with_check mismatch';
  END IF;

  SELECT * INTO p FROM pg_policies WHERE schemaname = 'public' AND tablename = 'properties'
    AND policyname = 'properties_delete_development';
  IF NOT FOUND OR p.permissive <> 'PERMISSIVE' OR p.cmd <> 'DELETE'
     OR p.roles <> ARRAY['anon'::name]
     OR replace(replace(COALESCE(p.qual, ''), '(', ''), ')', '') <> 'true' OR p.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'properties_delete_development role/cmd/qual/with_check mismatch';
  END IF;
END
$$;
SQL

  echo "KNOWN PRODUCTION DRIFT: REPORTED"
  echo "CANONICAL REPO REPLAY: PASS"
}

case "${1:-}" in
  emit) emit_baseline ;;
  apply) apply_baseline ;;
  assert) assert_equivalence ;;
  *) usage ;;
esac
