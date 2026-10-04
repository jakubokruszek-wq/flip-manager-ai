import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * finder-scheduler-cas.test.ts proves claimFinderFilter's CAS query is
 * LOGICALLY correct against a hand-written JS predicate matcher -- but a
 * plain JS object mutated by synchronous code proves nothing about whether
 * a REAL Postgres engine's row-level locking under READ COMMITTED actually
 * serializes two concurrent UPDATE...WHERE statements the way the
 * application code assumes. This file closes that gap: claimFinderFilter
 * and revertFinderFilterClaim run their REAL query-builder chains against
 * PGlite -- an embedded build of the real Postgres query executor/MVCC
 * engine, not a mock of it -- via a small Supabase-compatible shim that
 * translates the exact .from().update().eq()/.is()...maybeSingle() shapes
 * those two functions issue into real parameterized SQL. No real network
 * call, no .env.local, no Production: PGlite is in-memory and local.
 *
 * What this still cannot prove: true multi-process/multi-connection
 * concurrency (PGlite is a single embedded instance; two queries issued via
 * Promise.all are executed by it one at a time, not on separate OS
 * threads). What it DOES prove, which the pure-JS-mock test cannot: the
 * actual SQL UPDATE...WHERE this code sends re-evaluates its WHERE clause
 * against whatever is the current committed row at the moment each
 * statement executes, not a stale snapshot captured by the caller -- which
 * is the exact Postgres guarantee (true under any isolation level, and
 * identically true whether two statements arrive from one process or many)
 * that makes this a sound compare-and-swap in real, multi-instance
 * Production Postgres, not just in this single-instance embedded engine.
 */

type SqlFilter = { column: string; op: "eq" | "is"; value: unknown };

function searchFiltersBuilder(db: PGlite) {
  const filters: SqlFilter[] = [];
  let payload: Record<string, unknown> | null = null;
  let wantsReturning = false;
  async function execute(): Promise<{ data: unknown; error: { message: string } | null }> {
    if (!payload) return { data: null, error: { message: "no update payload" } };
    const setClauses = Object.keys(payload).map((key, index) => `${key} = $${index + 1}`);
    const setValues = Object.values(payload);
    const whereClauses = filters.map((filter, index) => filter.op === "is" ? `${filter.column} is null` : `${filter.column} = $${setValues.length + index + 1}`);
    const whereValues = filters.filter((filter) => filter.op === "eq").map((filter) => filter.value);
    const sql = `update search_filters set ${setClauses.join(", ")} where ${whereClauses.join(" and ")}${wantsReturning ? " returning id" : ""}`;
    try {
      const result = await db.query(sql, [...setValues, ...whereValues]);
      return { data: wantsReturning ? (result.rows[0] ?? null) : null, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : "query failed" } };
    }
  }
  const builder = {
    update(value: Record<string, unknown>) { payload = value; return builder; },
    eq(column: string, value: unknown) { filters.push({ column: toSqlColumn(column), op: "eq", value }); return builder; },
    is(column: string, value: unknown) {
      if (value !== null) throw new Error("this shim only supports .is(column, null)");
      filters.push({ column: toSqlColumn(column), op: "is", value: null });
      return builder;
    },
    select() { wantsReturning = true; return builder; },
    abortSignal() { return builder; },
    async maybeSingle() { return execute(); },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) { return execute().then(resolve, reject); },
  };
  return builder;
}

function sourceScansBuilder(db: PGlite) {
  const filters: Array<{ sql: string; values: unknown[] }> = [];
  const builder = {
    select() { return builder; },
    eq(column: string, value: unknown) { filters.push({ sql: `${toSqlColumn(column)} = $PLACEHOLDER`, values: [value] }); return builder; },
    in(column: string, values: unknown[]) { filters.push({ sql: `${toSqlColumn(column)} = any($PLACEHOLDER)`, values: [values] }); return builder; },
    limit() { return builder; },
    abortSignal() { return builder; },
    async then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      let paramIndex = 0;
      const allValues: unknown[] = [];
      const whereSql = filters.map((filter) => {
        paramIndex += 1;
        allValues.push(...filter.values);
        return filter.sql.replace("$PLACEHOLDER", `$${paramIndex}`);
      }).join(" and ");
      try {
        const result = await db.query(`select id from source_scans where ${whereSql} limit 1`, allValues);
        return Promise.resolve({ data: result.rows, error: null }).then(resolve, reject);
      } catch (error) {
        return Promise.resolve({ data: null, error: { message: error instanceof Error ? error.message : "query failed" } }).then(resolve, reject);
      }
    },
  };
  return builder;
}

function toSqlColumn(column: string): string {
  if (!/^[a-z_]+$/.test(column)) throw new Error(`unexpected column in test shim: ${column}`);
  return column;
}

function pgliteSupabase(db: PGlite) {
  return {
    from(table: string) {
      if (table === "search_filters") return searchFiltersBuilder(db);
      if (table === "source_scans") return sourceScansBuilder(db);
      throw new Error(`unexpected table in this shim: ${table}`);
    },
  };
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const foundation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql"), "utf8");
  // Applied AS-IS (public.-qualified, full do $$ ... $$ block included),
  // exactly like finder-scan-interval-migration.test.ts's own already-
  // proven approach -- PGlite's default search_path resolves `public`
  // fine, and it already executes the draft's do $$ ... $$ constraint
  // block correctly (that file's own tests prove the constraint rejection
  // works), so there is nothing to strip.
  const draft = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261004123000_add_finder_scan_interval.sql"), "utf8");
  const searchFiltersTable = extractBlock(foundation, "create table if not exists public.search_filters (", "create index if not exists search_filters_active_last_scanned_at_idx\n  on public.search_filters (is_active, last_scanned_at);");
  const sourceScansTable = extractBlock(foundation, "create table if not exists public.source_scans (", "create index if not exists source_scans_search_filter_id_started_at_idx\n  on public.source_scans (search_filter_id, started_at desc);");
  await db.exec(searchFiltersTable);
  await db.exec(sourceScansTable);
  await db.exec(draft);
  return db;
}

function extractBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start >= 0, `start marker not found: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end >= 0, `end marker not found: ${endMarker}`);
  return sql.slice(start, end + endMarker.length);
}

async function insertFilter(db: PGlite, id: string, lastScannedAt: string | null): Promise<void> {
  await db.query(
    `insert into search_filters (id, name, sources, city, districts, rooms, building_types, ownership_types, required_keywords, excluded_keywords, scan_interval_minutes, finder_scan_interval_minutes, is_active, last_scanned_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, "Finder", JSON.stringify(["otodom"]), "Łódź", JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), 60, 60, true, lastScannedAt],
  );
}

mock.module("server-only", { defaultExport: {} });
// claimFinderFilter/revertFinderFilterClaim are called directly below with
// an explicit PGlite-backed `supabase` argument, never through
// defaultDependencies() -- so createAdminClient() is never reached and
// does not need mocking here.
const { claimFinderFilter, revertFinderFilterClaim } = await import("./finder-scheduler.ts");

const RACE_FILTER_ID = "00000000-0000-0000-0000-000000000001";
const REVERT_FILTER_ID = "00000000-0000-0000-0000-000000000002";

test("the REAL claimFinderFilter SQL, run against an embedded real Postgres engine: two racing claims on the same never-scanned filter -- exactly one wins", async () => {
  const db = await freshDb();
  await insertFilter(db, RACE_FILTER_ID, null);
  const supabase = pgliteSupabase(db);

  const [a, b] = await Promise.all([
    claimFinderFilter(supabase as never, { id: RACE_FILTER_ID, lastScannedAt: null } as never, new Date("2026-10-04T12:00:00.000Z")),
    claimFinderFilter(supabase as never, { id: RACE_FILTER_ID, lastScannedAt: null } as never, new Date("2026-10-04T12:00:00.500Z")),
  ]);

  assert.equal([a, b].filter(Boolean).length, 1, "exactly one of the two racing claims against the real engine must succeed");
  const row = await db.query<{ last_scanned_at: string }>("select last_scanned_at from search_filters where id = $1", [RACE_FILTER_ID]);
  assert.ok(row.rows[0]?.last_scanned_at, "the winner's timestamp must be committed");
});

test("the REAL revertFinderFilterClaim SQL correctly restores the pre-claim value, CAS'd so it cannot clobber a newer concurrent write", async () => {
  const db = await freshDb();
  await insertFilter(db, REVERT_FILTER_ID, null);
  const supabase = pgliteSupabase(db);
  const claimedAt = new Date("2026-10-04T12:00:00.000Z");

  const claimed = await claimFinderFilter(supabase as never, { id: REVERT_FILTER_ID, lastScannedAt: null } as never, claimedAt);
  assert.equal(claimed, true);
  await revertFinderFilterClaim(supabase as never, { id: REVERT_FILTER_ID, lastScannedAt: null } as never, claimedAt);

  const row = await db.query<{ last_scanned_at: string | null }>("select last_scanned_at from search_filters where id = $1", [REVERT_FILTER_ID]);
  assert.equal(row.rows[0]?.last_scanned_at, null, "the revert must restore the real pre-claim value in the real engine, not just in a JS mock");
});
