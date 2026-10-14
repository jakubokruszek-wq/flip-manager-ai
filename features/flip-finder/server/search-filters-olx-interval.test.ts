import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Durable "Interwał OLX" setting: only 24/48/72 h are accepted, it is written
 * to search_filters.finder_olx_scan_interval_minutes and read back by the
 * backend (scheduler). Before the migration is applied the save still goes
 * through without the column, and the backend reads null (queue no OLX).
 */

type Call = { table: string; op: "insert" | "update"; payload: Record<string, unknown> };
let calls: Call[] = [];
let missingColumns: string[] = [];
let storedRow: Record<string, unknown> = {};

function rowFrom(payload: Record<string, unknown>) {
  return { id: "filter-1", created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z", last_scanned_at: null, ...payload };
}

function query(table: string) {
  let op: Call["op"] = "insert";
  let payload: Record<string, unknown> = {};
  const finish = async () => {
    calls.push({ table, op, payload });
    const missing = missingColumns.find((column) => column in payload);
    if (missing) return { data: null, error: { code: "PGRST204", message: `Could not find the '${missing}' column of 'search_filters' in the schema cache` } };
    storedRow = rowFrom(payload);
    return { data: storedRow, error: null };
  };
  const builder = {
    insert(value: Record<string, unknown>) { op = "insert"; payload = value; return builder; },
    update(value: Record<string, unknown>) { op = "update"; payload = value; return builder; },
    select() { return builder; },
    eq() { return builder; },
    single: finish,
    maybeSingle: async () => {
      if (!Object.keys(payload).length) return { data: storedRow, error: null };
      return finish();
    },
  };
  return builder;
}

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({ from: query }) } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => ({ from: query }) } });

const { parseSearchFilterInput, createSearchFilter, getSearchFilter } = await import("./search-filters.ts");

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Flip", sources: ["otodom", "olx"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null,
    rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, yearBuiltMin: null,
    buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: null, requiredKeywords: [],
    excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null,
    scanIntervalMinutes: 60, finderScanIntervalMinutes: 300, isActive: true, ...overrides,
  };
}

test("only 12 h, 24 h, 48 h and 72 h are accepted; a missing value defaults to 24 h; start time HH:mm every 5 min, default 08:00", () => {
  for (const minutes of [720, 1440, 2880, 4320]) assert.equal(parseSearchFilterInput(input({ finderOlxScanIntervalMinutes: minutes })).finderOlxScanIntervalMinutes, minutes);
  assert.equal(parseSearchFilterInput(input()).finderOlxScanIntervalMinutes, 1440);
  for (const minutes of [300, 60, 600, 1439, 1441, 10_080, "1440", -1440]) {
    assert.throws(() => parseSearchFilterInput(input({ finderOlxScanIntervalMinutes: minutes })), /Interwał OLX/);
  }
  assert.equal(parseSearchFilterInput(input()).finderScanIntervalMinutes, 300, "the other portals keep their own interval");
  assert.equal(parseSearchFilterInput(input()).finderOlxStartTime, "08:00");
  for (const time of ["00:00", "07:55", "20:00", "23:55"]) assert.equal(parseSearchFilterInput(input({ finderOlxStartTime: time })).finderOlxStartTime, time);
  for (const time of ["08:03", "24:00", "8:00", "08:00:00", "", 800]) assert.throws(() => parseSearchFilterInput(input({ finderOlxStartTime: time })), /Godzina startu OLX/);
});

test("the interval is persisted in its own column and read back by the backend", async () => {
  calls = []; missingColumns = [];
  const saved = await createSearchFilter(parseSearchFilterInput(input({ finderOlxScanIntervalMinutes: 2880 })));
  assert.equal(calls[0].payload.finder_olx_scan_interval_minutes, 2880);
  assert.equal(calls[0].payload.finder_olx_start_time, "08:00");
  assert.equal(calls[0].payload.finder_scan_interval_minutes, 300);
  assert.equal(saved.finderOlxScanIntervalMinutes, 2880);
  // A later read (e.g. after an application restart) gets the stored value.
  const reread = await getSearchFilter("filter-1");
  assert.equal(reread?.finderOlxScanIntervalMinutes, 2880);
});

test("before the migration: the save goes through without the OLX column and the backend reads null", async () => {
  calls = []; missingColumns = ["finder_olx_scan_interval_minutes"];
  const saved = await createSearchFilter(parseSearchFilterInput(input({ finderOlxScanIntervalMinutes: 1440 })));
  assert.equal(calls.length, 2);
  assert.equal("finder_olx_scan_interval_minutes" in calls[1].payload, false);
  assert.equal(calls[1].payload.finder_scan_interval_minutes, 300, "every other field is still saved");
  assert.equal(saved.finderOlxScanIntervalMinutes, null, "unknown interval -> the OLX scheduler queues nothing");
});

test("several draft columns missing at once are all dropped", async () => {
  calls = []; missingColumns = ["year_built_min", "finder_olx_scan_interval_minutes"];
  await createSearchFilter(parseSearchFilterInput(input()));
  const last = calls.at(-1)!.payload;
  assert.equal("year_built_min" in last, false);
  assert.equal("finder_olx_scan_interval_minutes" in last, false);
  assert.equal(last.name, "Flip");
});

test("an unexpected stored value reads as null, never as a shorter interval", async () => {
  calls = []; missingColumns = [];
  await createSearchFilter(parseSearchFilterInput(input()));
  storedRow = { ...storedRow, finder_olx_scan_interval_minutes: 60 };
  const filter = await getSearchFilter("filter-1");
  assert.equal(filter?.finderOlxScanIntervalMinutes, null);
});

test("the start time stored by Postgres (HH:mm:ss) reads back as HH:mm; unreadable reads as null", async () => {
  calls = []; missingColumns = [];
  await createSearchFilter(parseSearchFilterInput(input({ finderOlxStartTime: "20:05" })));
  storedRow = { ...storedRow, finder_olx_start_time: "20:05:00" };
  assert.equal((await getSearchFilter("filter-1"))?.finderOlxStartTime, "20:05");
  storedRow = { ...storedRow, finder_olx_start_time: undefined };
  assert.equal((await getSearchFilter("filter-1"))?.finderOlxStartTime, null);
});
