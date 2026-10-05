#!/usr/bin/env bash
set -euo pipefail

# Real, two-connection concurrency proof for reserve_source_scans
# (supabase/migrations/20261004020000_add_manual_scan_reservation_lock.sql).
#
# Closes the one remaining gap left as a test.todo() in
# features/flip-finder/server/reserve-source-scans.rpc.test.ts: PGlite (used
# by that file's other test, and explicitly not acceptable as proof here)
# executes every query through a single embedded connection, so it cannot
# demonstrate the function's `select ... for update` row lock actually
# blocking a second, genuinely concurrent session -- only two real,
# independent PostgreSQL connections can. This script is invoked by
# .github/workflows/reserve-source-scans-concurrency.yml against a
# disposable `services: postgres:` container; it never contacts Production
# or Supabase, and requires $DATABASE_URL to point at that disposable
# server (refuses to run otherwise).
#
# Proof shape: two psql client processes (two real server connections) are
# released from a file-based barrier at the same instant, both calling
# reserve_source_scans for the SAME search_filter_id/source. Postgres' own
# row lock inside the function (not this script) is what then forces
# whichever call loses the race to block until the winner's implicit
# transaction commits, after which it observes the winner's committed row
# and raises SCAN_ALREADY_RUNNING -- exactly the serialization a missing or
# broken lock would fail to produce (see this same migration's other test:
# "without the reservation migration applied, two concurrent ... still both
# win"). The outcome asserted below (exactly one winner, exactly one row,
# the loser's own real error) is only reachable if that block-then-observe
# sequence actually happened; there is no code path to this result without it.

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required: a real PostgreSQL connection string (never Production/Supabase)." >&2
  exit 1
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
FILTER_ID="00000000-0000-0000-0000-00000000a001"
RUN_ID_A="00000000-0000-0000-0000-00000000a002"
RUN_ID_B="00000000-0000-0000-0000-00000000a003"
WORKDIR="${RUNNER_TEMP:-/tmp}/reserve-source-scans-race"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

log() { printf '%s\n' "$*"; }

wait_for_postgres() {
  for _ in $(seq 1 30); do
    if psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL did not become reachable within 30 seconds." >&2
  return 1
}

# Extracts one migration's SQL block the exact same way
# reserve-source-scans.rpc.test.ts's own extractBlock() does (whole-file
# indexOf, not a per-line pattern), so a multi-line end marker works
# identically to that already-proven test.
extract_block() {
  node -e '
    const fs = require("fs");
    const [file, start, end] = process.argv.slice(1);
    const content = fs.readFileSync(file, "utf8");
    const startIdx = content.indexOf(start);
    if (startIdx < 0) { console.error("start marker not found in " + file + ": " + start); process.exit(1); }
    const endIdx = content.indexOf(end, startIdx);
    if (endIdx < 0) { console.error("end marker not found in " + file + ": " + end); process.exit(1); }
    process.stdout.write(content.slice(startIdx, endIdx + end.length));
  ' "$1" "$2" "$3"
}

apply_schema() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end
$$;
SQL

  extract_block "$MIGRATIONS_DIR/20260719113000_create_flip_finder_foundation.sql" \
    'create table if not exists public.search_filters (' \
    $'create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);' \
    > "$WORKDIR/01-search-filters.sql"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$WORKDIR/01-search-filters.sql"

  extract_block "$MIGRATIONS_DIR/20260719113000_create_flip_finder_foundation.sql" \
    'create table if not exists public.source_scans (' \
    $'create index if not exists source_scans_search_filter_id_started_at_idx\n  on public.source_scans (search_filter_id, started_at desc);' \
    > "$WORKDIR/02-source-scans.sql"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$WORKDIR/02-source-scans.sql"

  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$MIGRATIONS_DIR/20260719131000_add_source_scan_diagnostics.sql"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$MIGRATIONS_DIR/20261004020000_add_manual_scan_reservation_lock.sql"

  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc \
    "insert into public.search_filters (id, name, sources, scan_interval_minutes) values ('$FILTER_ID', 'Race fixture', '[\"otodom\"]'::jsonb, 60);"
}

# Launches both reserve_source_scans calls from a file-based barrier so
# neither process can submit its call before both are ready -- a forced
# simultaneous arrival at the real lock, not an incidental one.
run_race() {
  local go="$WORKDIR/go" ready_a="$WORKDIR/a.ready" ready_b="$WORKDIR/b.ready"
  local out_a="$WORKDIR/a.out" out_b="$WORKDIR/b.out" err_a="$WORKDIR/a.err" err_b="$WORKDIR/b.err"
  rm -f "$go" "$ready_a" "$ready_b"

  local sql_a="select scan_run_id from public.reserve_source_scans('$FILTER_ID'::uuid, array['otodom']::text[], '$RUN_ID_A'::uuid, '{}'::jsonb);"
  local sql_b="select scan_run_id from public.reserve_source_scans('$FILTER_ID'::uuid, array['otodom']::text[], '$RUN_ID_B'::uuid, '{}'::jsonb);"

  (
    touch "$ready_a"
    while [[ ! -e "$go" ]]; do sleep 0.01; done
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$sql_a"
  ) >"$out_a" 2>"$err_a" &
  local pid_a=$!

  (
    touch "$ready_b"
    while [[ ! -e "$go" ]]; do sleep 0.01; done
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "$sql_b"
  ) >"$out_b" 2>"$err_b" &
  local pid_b=$!

  for _ in $(seq 1 500); do
    [[ -e "$ready_a" && -e "$ready_b" ]] && break
    sleep 0.01
  done
  if [[ ! -e "$ready_a" || ! -e "$ready_b" ]]; then
    kill "$pid_a" "$pid_b" 2>/dev/null || true
    echo "Both race sessions failed to reach the barrier." >&2
    exit 1
  fi

  touch "$go"
  set +e
  wait "$pid_a"; STATUS_A=$?
  wait "$pid_b"; STATUS_B=$?
  set -e
  OUT_A="$(tr -d '\r\n' < "$out_a")"
  OUT_B="$(tr -d '\r\n' < "$out_b")"
  ERR_A="$(cat "$err_a")"
  ERR_B="$(cat "$err_b")"
}

main() {
  wait_for_postgres
  apply_schema
  run_race

  log "A: status=$STATUS_A output='$OUT_A'"
  log "B: status=$STATUS_B output='$OUT_B'"
  [[ -n "$ERR_A" ]] && log "A stderr: $ERR_A"
  [[ -n "$ERR_B" ]] && log "B stderr: $ERR_B"

  local winners=0
  [[ "$STATUS_A" -eq 0 ]] && winners=$((winners + 1))
  [[ "$STATUS_B" -eq 0 ]] && winners=$((winners + 1))
  if [[ "$winners" -ne 1 ]]; then
    echo "FAIL: expected exactly one winner, got $winners (A status=$STATUS_A, B status=$STATUS_B)." >&2
    exit 1
  fi

  local winner_run_id loser_err
  if [[ "$STATUS_A" -eq 0 ]]; then
    [[ "$OUT_A" == "$RUN_ID_A" ]] || { echo "FAIL: A won but did not return its own scan_run_id (got '$OUT_A')." >&2; exit 1; }
    [[ "$STATUS_B" -ne 0 ]] || { echo "FAIL: B must have failed if A won." >&2; exit 1; }
    loser_err="$ERR_B"
    winner_run_id="$RUN_ID_A"
  else
    [[ "$OUT_B" == "$RUN_ID_B" ]] || { echo "FAIL: B won but did not return its own scan_run_id (got '$OUT_B')." >&2; exit 1; }
    loser_err="$ERR_A"
    winner_run_id="$RUN_ID_B"
  fi

  if [[ "$loser_err" != *"SCAN_ALREADY_RUNNING"* ]]; then
    echo "FAIL: the losing call's error did not mention SCAN_ALREADY_RUNNING: $loser_err" >&2
    exit 1
  fi
  log "PASS: exactly one of the two genuinely concurrent calls won (run_id=$winner_run_id); the other blocked on the real row lock and then received SCAN_ALREADY_RUNNING."

  local row_count run_ids
  row_count="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "select count(*) from public.source_scans where search_filter_id = '$FILTER_ID';")"
  run_ids="$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qAtc "select distinct scan_run_id from public.source_scans where search_filter_id = '$FILTER_ID';")"
  if [[ "$row_count" != "1" ]]; then
    echo "FAIL: expected exactly one active source_scans row for the filter, found $row_count." >&2
    exit 1
  fi
  if [[ "$run_ids" != "$winner_run_id" ]]; then
    echo "FAIL: the surviving row's scan_run_id ($run_ids) does not match the winner ($winner_run_id)." >&2
    exit 1
  fi
  log "PASS: exactly one source_scans row exists for the filter, with exactly one scan_run_id ($run_ids)."
}

main
