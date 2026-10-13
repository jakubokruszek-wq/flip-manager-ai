#!/usr/bin/env bash
set -euo pipefail

# Real multi-connection proof that the existing queue function
# claim_olx_scan_job (supabase/migrations/20260810190000_create_olx_local_worker_queue.sql)
# never hands one OLX job to two workers, and that an expired lease (a killed
# container) is recovered with a fresh token. This matters for the cloud
# worker: during a Railway redeploy the old and new container may overlap, and
# the Windows worker may still be running while the cloud one starts.
#
# The script creates a throw-away PostgreSQL cluster in a temp directory (unix
# socket only, no TCP) and deletes it afterwards. It never contacts Supabase
# or Production. Prerequisite tables are minimal stubs; the queue migration
# itself is applied unmodified.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260810190000_create_olx_local_worker_queue.sql"
JOBS=${JOBS:-40}
WORKERS=${WORKERS:-8}
PG_BIN=${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
[[ -x "$PG_BIN/initdb" ]] || { echo "PostgreSQL server binaries not found (set PG_BIN)." >&2; exit 1; }

WORKDIR="$(mktemp -d)"
chmod 755 "$WORKDIR"
RUN_AS=()
if [[ "$(id -u)" == "0" ]]; then RUN_AS=(runuser -u postgres --); chown postgres "$WORKDIR"; fi
cleanup() { "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORKDIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORKDIR/data" -U postgres --auth=trust >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORKDIR/data" -w -l "$WORKDIR/pg.log" \
  -o "-c listen_addresses='' -k $WORKDIR -c max_connections=$((WORKERS + 10))" start >/dev/null
export PGHOST="$WORKDIR" PGUSER=postgres PGDATABASE=postgres
sql() { psql -X -v ON_ERROR_STOP=1 -qAt "$@"; }

sql <<'SQL'
create role anon; create role authenticated; create role service_role;
create table public.search_filters (id uuid primary key default gen_random_uuid());
create table public.source_scans (
  id uuid primary key default gen_random_uuid(),
  search_filter_id uuid not null references public.search_filters(id),
  status text not null default 'pending',
  finished_at timestamptz,
  error_message text
);
SQL
sql -f "$MIGRATION"
sql -c "
  with filter as (insert into public.search_filters default values returning id),
  scans as (insert into public.source_scans (search_filter_id) select filter.id from filter, generate_series(1, $JOBS) returning id, search_filter_id)
  insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key)
  select gen_random_uuid(), id, search_filter_id, 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/', 'race-' || id from scans;"

# Every worker gets its own connection and claims in a tight loop; all of them
# are released from one barrier so they hit the same "oldest queued" row.
for worker in $(seq 1 "$WORKERS"); do
  for _ in $(seq 1 $((JOBS / WORKERS + 5))); do echo "select id from public.claim_olx_scan_job('race-worker-$worker', 120);"; done > "$WORKDIR/worker-$worker.sql"
  ( while [[ ! -f "$WORKDIR/go" ]]; do sleep 0.01; done; sql -f "$WORKDIR/worker-$worker.sql" > "$WORKDIR/claimed-$worker.txt" ) &
done
touch "$WORKDIR/go"
wait

cat "$WORKDIR"/claimed-*.txt | sed '/^$/d' > "$WORKDIR/all.txt"
total=$(wc -l < "$WORKDIR/all.txt")
unique=$(sort -u "$WORKDIR/all.txt" | wc -l)
active=$(find "$WORKDIR" -name "claimed-*.txt" -size +0 | wc -l)
running=$(sql -c "select count(*) from public.olx_scan_jobs where status = 'running' and attempts = 1 and lease_token is not null")
echo "claims=$total unique=$unique jobs=$JOBS workers_with_claims=$active/$WORKERS running=$running"
[[ "$total" == "$JOBS" && "$unique" == "$JOBS" && "$running" == "$JOBS" ]] || { echo "FAIL: duplicate or missing claims" >&2; exit 1; }

# Lease recovery after a killed container: expire 3 leases, reclaim, expect a
# new token and attempt 2; the old token no longer matches any row.
sql -c "create table expired as select id, lease_token from public.olx_scan_jobs order by created_at limit 3;
        update public.olx_scan_jobs set leased_until = now() - interval '1 second' where id in (select id from expired);"
for _ in 1 2 3; do sql -c "select id from public.claim_olx_scan_job('replacement-worker', 120)" > /dev/null; done
recovered=$(sql -c "select count(*) from public.olx_scan_jobs j join expired e using (id) where j.attempts = 2 and j.worker_id = 'replacement-worker' and j.lease_token <> e.lease_token")
stale=$(sql -c "select count(*) from public.olx_scan_jobs j join expired e on e.lease_token = j.lease_token")
echo "recovered=$recovered stale_tokens_still_valid=$stale"
[[ "$recovered" == "3" && "$stale" == "0" ]] || { echo "FAIL: lease recovery" >&2; exit 1; }

# A job whose lease expires at max_attempts is failed, not handed out forever.
sql -c "update public.olx_scan_jobs set attempts = max_attempts, leased_until = now() - interval '1 second' where id = (select id from expired limit 1);"
sql -c "select id from public.claim_olx_scan_job('replacement-worker', 120)" > /dev/null
exhausted=$(sql -c "select count(*) from public.olx_scan_jobs where error_code = 'LEASE_EXHAUSTED' and status = 'failed'")
echo "exhausted=$exhausted"
[[ "$exhausted" == "1" ]] || { echo "FAIL: exhausted lease handling" >&2; exit 1; }
echo "CLAIM_RACE_OK"
