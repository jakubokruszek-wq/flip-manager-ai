#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PHASE1="0F283BC5E2B351A6F500D140242E55CFEB6D44B936CAF52D1FCF99F4A5E6270D"
EXPECTED_CAS="E0F8FD969B825ADD0FF8BD8BAF0B36AB6E8665941A4BF11DE2C50D5D125D099A"
MIGRATION_DIR="supabase/migrations"
LISTING_ID="9b978638-2284-4f6a-a425-6a6c34f11a01"
INITIAL_DEAL_ID="519db8aa-a7dc-4895-a74b-cc416ce7e101"
RACE_DEAL_ID="519db8aa-a7dc-4895-a74b-cc416ce7e102"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROPERTIES_BASELINE_HARNESS="$SCRIPT_DIR/ephemeral-properties-baseline.sh"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for the ephemeral PostgreSQL service." >&2
  exit 1
fi

summary() {
  printf '%s\n' "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

sha256_file() {
  sha256sum "$1" | awk '{ print toupper($1) }'
}

phase1_hash="$(sha256_file "$MIGRATION_DIR/20260912120000_create_investment_os_phase1.sql")"
cas_hash="$(sha256_file "$MIGRATION_DIR/20260912180000_investment_os_deal_cas.sql")"
if [[ "$phase1_hash" != "$EXPECTED_PHASE1" || "$cas_hash" != "$EXPECTED_CAS" ]]; then
  echo "Migration checksum guard failed; no migrations were applied." >&2
  echo "Phase1 actual: $phase1_hash" >&2
  echo "CAS actual: $cas_hash" >&2
  exit 1
fi
summary "- Reviewed migration hashes before tests: PASS"

mapfile -t migrations < <(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)
if [[ "${#migrations[@]}" -ne 36 ]]; then
  echo "Expected 36 chronological migrations; found ${#migrations[@]}." >&2
  exit 1
fi

connected=false
for attempt in $(seq 1 30); do
  if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc 'select 1' >/dev/null 2>&1; then
    connected=true
    break
  fi
  sleep 1
done
if [[ "$connected" != true ]]; then
  echo "ENVIRONMENTAL BLOCKER: PostgreSQL service did not become reachable within 30 seconds." >&2
  exit 1
fi

if ! psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE ROLE anon NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'CREATE ROLE authenticated NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE ROLE service_role NOLOGIN BYPASSRLS';
  END IF;
END
$$;
ALTER ROLE service_role BYPASSRLS;
SQL
then
  echo "ENVIRONMENTAL BLOCKER: unable to create disposable PostgreSQL role equivalents." >&2
  exit 1
fi

summary "- Local platform role equivalents created: anon, authenticated, service_role (service_role BYPASSRLS)"
if ! bash "$PROPERTIES_BASELINE_HARNESS" apply; then
  echo "CI HARNESS BLOCKER: ephemeral historical properties baseline did not apply." >&2
  exit 1
fi
summary "- Historical public.properties baseline: PASS (ephemeral PostgreSQL only)"
summary "- Full repository migration chain: 36/36"

mkdir -p "$RUNNER_TEMP/investment-os-postgres-logs"
for migration in "${migrations[@]}"; do
  log="$RUNNER_TEMP/investment-os-postgres-logs/$migration.log"
  if ! psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$MIGRATION_DIR/$migration" >"$log" 2>&1; then
    echo "PRODUCT/MIGRATION BLOCKER" >&2
    echo "MIGRATION: $migration" >&2
    echo "ERROR:" >&2
    sed -E \
      -e 's#(postgres(ql)?://[^:/ ]+):[^@/ ]+@#\1:REDACTED@#g' \
      -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' \
      "$log" >&2
    summary "- Migration chain: FAIL at $migration (PRODUCT/MIGRATION BLOCKER)"
    exit 1
  fi
  printf 'Applied migration: %s\n' "$migration"
done

if ! bash "$PROPERTIES_BASELINE_HARNESS" assert; then
  echo "PRODUCT BLOCKER: reconstructed public.properties does not match the supplied Production schema proof." >&2
  summary "- Historical properties equivalence: FAIL (PRODUCT/MIGRATION BLOCKER)"
  exit 1
fi
summary "- Historical properties column/constraint/index/RLS/policy equivalence: PASS"

if ! psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE
  v_listing_att smallint;
  v_unique_index_count integer;
  v_unique_constraint_count integer;
  v_table text;
  v_investment_tables text[] := ARRAY[
    'deals', 'deal_evidence', 'director_runs', 'director_information_requests',
    'deal_fact_overrides', 'market_assumptions', 'underwriting_settings',
    'deal_outcomes', 'director_scorecards', 'listing_fact_observations',
    'deal_fact_override_events', 'deal_fact_override_confirmations',
    'evidence_conflicts', 'director_outputs', 'ceo_decisions', 'deal_actual_outcomes'
  ];
BEGIN
  IF to_regclass('public.deals') IS NULL THEN RAISE EXCEPTION 'SCHEMA_ASSERT: public.deals missing'; END IF;
  SELECT attnum INTO v_listing_att FROM pg_attribute
    WHERE attrelid = 'public.deals'::regclass AND attname = 'listing_id' AND NOT attisdropped;
  IF v_listing_att IS NULL THEN RAISE EXCEPTION 'SCHEMA_ASSERT: deals.listing_id missing'; END IF;

  SELECT count(*) INTO v_unique_index_count FROM pg_index i
    WHERE i.indrelid = 'public.deals'::regclass AND i.indisunique AND i.indpred IS NULL
      AND i.indnkeyatts = 1 AND i.indkey[0] = v_listing_att;
  SELECT count(*) INTO v_unique_constraint_count FROM pg_constraint c
    WHERE c.conrelid = 'public.deals'::regclass AND c.contype = 'u'
      AND c.conkey = ARRAY[v_listing_att]::smallint[];
  IF v_unique_index_count <> 1 OR v_unique_constraint_count <> 1 THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: expected exactly one unique listing_id constraint/index; indexes %, constraints %', v_unique_index_count, v_unique_constraint_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.deals'::regclass AND c.contype = 'f'
      AND c.conkey = ARRAY[v_listing_att]::smallint[] AND c.confrelid = 'public.listings'::regclass) THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals.listing_id foreign key to listings missing';
  END IF;

  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.deals'::regclass AND attname = 'listing_id') <> 'uuid' THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals.listing_id must be uuid';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.deals'::regclass AND attname = 'version') <> 'integer' THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals.version must be integer';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.deals'::regclass AND attname = 'source_updated_at') <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals.source_updated_at must be timestamptz';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.deals'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%version%> 0%') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals.version positive constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'deals' AND indexname = 'deals_stage_updated_at_idx') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: deals_stage_updated_at_idx missing';
  END IF;

  FOREACH v_table IN ARRAY v_investment_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      RAISE EXCEPTION 'SCHEMA_ASSERT: public.% missing', v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(format('public.%I', v_table))) THEN
      RAISE EXCEPTION 'SCHEMA_ASSERT: RLS not enabled on public.%', v_table;
    END IF;
    IF has_table_privilege('anon', format('public.%I', v_table), 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'SCHEMA_ASSERT: anon/authenticated unexpectedly have access to public.%', v_table;
    END IF;
    IF NOT has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
       OR NOT has_table_privilege('service_role', format('public.%I', v_table), 'INSERT') THEN
      RAISE EXCEPTION 'SCHEMA_ASSERT: service_role missing SELECT/INSERT on public.%', v_table;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.deals', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.deals', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.deals', 'UPDATE') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: service_role missing required deals privileges';
  END IF;
  IF has_table_privilege('service_role', 'public.deals', 'DELETE') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: service_role unexpectedly has deals DELETE';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: local service_role BYPASSRLS mismatch';
  END IF;

  IF to_regprocedure('public.persist_investment_deal_cas(jsonb,integer,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.mark_investment_deal_stale_cas(uuid,integer,text[])') IS NULL
     OR to_regprocedure('public.apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: one or more CAS RPC signatures missing';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.persist_investment_deal_cas(jsonb,integer,timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.persist_investment_deal_cas(jsonb,integer,timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.persist_investment_deal_cas(jsonb,integer,timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: persist CAS RPC grants are incorrect';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.mark_investment_deal_stale_cas(uuid,integer,text[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: service_role missing stale/override CAS RPC execute';
  END IF;
  IF has_function_privilege('anon', 'public.mark_investment_deal_stale_cas(uuid,integer,text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mark_investment_deal_stale_cas(uuid,integer,text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.apply_investment_override_cas(uuid,integer,jsonb,text[],jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SCHEMA_ASSERT: anon/authenticated can execute a CAS RPC';
  END IF;
END
$$;
SQL
then
  echo "PRODUCT BLOCKER: real database schema/RLS/grant/RPC verification failed." >&2
  summary "- Real PostgreSQL schema verification: FAIL (PRODUCT BLOCKER)"
  exit 1
fi

echo "Schema verification assertions: PASS"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT c.conname AS unique_constraint, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid='public.deals'::regclass AND c.contype='u'; SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='deals' AND column_name IN ('listing_id','version','source_updated_at') ORDER BY ordinal_position; SELECT count(*) AS investment_os_policy_count FROM pg_policies WHERE schemaname='public' AND tablename = ANY(ARRAY['deals','deal_evidence','director_runs','director_information_requests','deal_fact_overrides','market_assumptions','underwriting_settings','deal_outcomes','director_scorecards','listing_fact_observations','deal_fact_override_events','deal_fact_override_confirmations','evidence_conflicts','director_outputs','ceo_decisions','deal_actual_outcomes']);"
summary "- Real PostgreSQL schema/RLS/grants/RPC verification: PASS (Investment OS tables are backend-only; no user policies are required)"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO public.listings (id, source, external_listing_id, original_url, title, price, area, rooms, city, district, description, updated_at) VALUES ('$LISTING_ID', 'facebook', '9876543210123456', 'https://www.facebook.com/groups/123456789012345/permalink/9876543210123456/', 'Ephemeral Investment OS race fixture', 250000, 45, 2, 'Łódź', 'Test', 'Disposable local fixture only', '2000-01-01T00:00:00Z');"
SOURCE_TS="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM public.listings WHERE id='$LISTING_ID';")"
if [[ -z "$SOURCE_TS" ]]; then echo "Fixture listing source timestamp was not readable." >&2; exit 1; fi

make_deal_payload() {
  local deal_id="$1"
  local marker="$2"
  printf '{"id":"%s","listing_id":"%s","stage":"DISCOVERED","facts_fingerprint":"fixture-%s","facts":{"raceMarker":"%s"},"scout":{},"verify":{},"market":{},"underwriting":{},"ceo":{},"playbook":{},"evidence_fabric":[],"information_requests":[],"analysis_level":1}' \
    "$deal_id" "$LISTING_ID" "$marker" "$marker"
}

make_rpc_sql() {
  local deal_id="$1"
  local marker="$2"
  local expected_version="$3"
  local source_ts="$4"
  local payload
  payload="$(make_deal_payload "$deal_id" "$marker")"
  printf "SELECT COALESCE(public.persist_investment_deal_cas(\$\$%s\$\$::jsonb, %s, '%s'::timestamptz)::text, 'NULL');" \
    "$payload" "$expected_version" "$source_ts"
}

run_parallel_pair() {
  local sql_a="$1" sql_b="$2" label="$3"
  local dir="$RUNNER_TEMP/investment-os-$label"
  mkdir -p "$dir"
  local go="$dir/go" ready_a="$dir/a.ready" ready_b="$dir/b.ready"
  local out_a="$dir/a.out" out_b="$dir/b.out"
  rm -f "$go" "$ready_a" "$ready_b" "$out_a" "$out_b"
  (
    touch "$ready_a"
    while [[ ! -e "$go" ]]; do sleep 0.01; done
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$sql_a"
  ) >"$out_a" 2>&1 &
  local pid_a=$!
  (
    touch "$ready_b"
    while [[ ! -e "$go" ]]; do sleep 0.01; done
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$sql_b"
  ) >"$out_b" 2>&1 &
  local pid_b=$!
  for attempt in $(seq 1 500); do
    [[ -e "$ready_a" && -e "$ready_b" ]] && break
    sleep 0.01
  done
  if [[ ! -e "$ready_a" || ! -e "$ready_b" ]]; then
    kill "$pid_a" "$pid_b" 2>/dev/null || true
    echo "Parallel $label sessions failed to reach the barrier." >&2
    return 1
  fi
  touch "$go"
  set +e
  wait "$pid_a"; local status_a=$?
  wait "$pid_b"; local status_b=$?
  set -e
  if [[ $status_a -ne 0 || $status_b -ne 0 ]]; then
    echo "Parallel $label SQL/RPC failed." >&2
    sed -E -e 's#(postgres(ql)?://[^:/ ]+):[^@/ ]+@#\1:REDACTED@#g' -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' "$out_a" "$out_b" >&2
    return 1
  fi
  PAIR_A="$(tr -d '\r\n' < "$out_a")"
  PAIR_B="$(tr -d '\r\n' < "$out_b")"
}

init_sql_a="$(make_rpc_sql "$INITIAL_DEAL_ID" initialize-a 0 "$SOURCE_TS")"
init_sql_b="$(make_rpc_sql "$RACE_DEAL_ID" initialize-b 0 "$SOURCE_TS")"
run_parallel_pair "$init_sql_a" "$init_sql_b" initialize
init_winners=0
[[ "$PAIR_A" == "1" ]] && ((init_winners+=1))
[[ "$PAIR_B" == "1" ]] && ((init_winners+=1))
if [[ $init_winners -ne 1 ]] || { [[ "$PAIR_A" != "NULL" && "$PAIR_A" != "1" ]] || [[ "$PAIR_B" != "NULL" && "$PAIR_B" != "1" ]]; }; then
  echo "Initialize CAS race did not produce exactly one insert winner (A=$PAIR_A B=$PAIR_B)." >&2
  exit 1
fi
row_count="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT count(*) FROM public.deals WHERE listing_id='$LISTING_ID';")"
deal_id="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT id FROM public.deals WHERE listing_id='$LISTING_ID';")"
if [[ "$row_count" != "1" ]]; then echo "Initialize CAS created $row_count rows, expected exactly one." >&2; exit 1; fi
summary "- Real concurrent initialize RPC: PASS (A=$PAIR_A, B=$PAIR_B, rows=$row_count, deal=$deal_id)"

cas_sql_a="$(make_rpc_sql "$deal_id" writer-a 1 "$SOURCE_TS")"
cas_sql_b="$(make_rpc_sql "$deal_id" writer-b 1 "$SOURCE_TS")"
run_parallel_pair "$cas_sql_a" "$cas_sql_b" cas
cas_winners=0
[[ "$PAIR_A" == "2" ]] && ((cas_winners+=1))
[[ "$PAIR_B" == "2" ]] && ((cas_winners+=1))
if [[ $cas_winners -ne 1 ]] || { [[ "$PAIR_A" != "NULL" && "$PAIR_A" != "2" ]] || [[ "$PAIR_B" != "NULL" && "$PAIR_B" != "2" ]]; }; then
  echo "CAS race did not produce exactly one version-2 winner (A=$PAIR_A B=$PAIR_B)." >&2
  exit 1
fi
version="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT version FROM public.deals WHERE listing_id='$LISTING_ID';")"
winner="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT facts->>'raceMarker' FROM public.deals WHERE listing_id='$LISTING_ID';")"
if [[ "$version" != "2" || "$winner" != "writer-a" && "$winner" != "writer-b" ]]; then
  echo "CAS race final state invalid (version=$version marker=$winner)." >&2
  exit 1
fi
summary "- Real concurrent stale-version CAS race: PASS (one winner, final version=$version, payload=$winner)"

NEW_SOURCE_TS="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "UPDATE public.listings SET title='Newer source snapshot', updated_at=now() WHERE id='$LISTING_ID' RETURNING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")"
fresh_sql="$(make_rpc_sql "$deal_id" source-new 2 "$NEW_SOURCE_TS")"
fresh_result="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$fresh_sql")"
if [[ "$fresh_result" != "3" ]]; then echo "Fresh source CAS write did not advance to version 3 (got $fresh_result)." >&2; exit 1; fi
stale_sql="$(make_rpc_sql "$deal_id" stale-old 3 "$SOURCE_TS")"
stale_result="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$stale_sql")"
final_version="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT version FROM public.deals WHERE listing_id='$LISTING_ID';")"
final_marker="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "SELECT facts->>'raceMarker' FROM public.deals WHERE listing_id='$LISTING_ID';")"
if [[ "$stale_result" != "NULL" || "$final_version" != "3" || "$final_marker" != "source-new" ]]; then
  echo "Source freshness CAS failed (old result=$stale_result, version=$final_version, marker=$final_marker)." >&2
  exit 1
fi
summary "- Source freshness race: PASS (newer source accepted at $NEW_SOURCE_TS; stale source rejected; version=$final_version)"

phase1_after="$(sha256_file "$MIGRATION_DIR/20260912120000_create_investment_os_phase1.sql")"
cas_after="$(sha256_file "$MIGRATION_DIR/20260912180000_investment_os_deal_cas.sql")"
if [[ "$phase1_after" != "$EXPECTED_PHASE1" || "$cas_after" != "$EXPECTED_CAS" ]]; then
  echo "Post-test migration checksum guard failed." >&2
  exit 1
fi
summary "- Reviewed migration hashes after tests: PASS"
summary "- Final DB state: one deal row, deal_id=$deal_id, version=$final_version, source payload=$final_marker"
