import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { fetchExternalPortal } from "../external-source-adapters.ts";
import type { SearchFilter } from "../index.ts";

const runId = "10000000-0000-4000-8000-000000000001";
const filter: SearchFilter = {
  id: "10000000-0000-4000-8000-000000000002", name: "Portions", sources: ["domy", "olx", "facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 30, isActive: true,
  lastScannedAt: null, createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
};
let db = new FakeFacebookSupabase();
let filterOptions: { supabase?: unknown; signal?: AbortSignal } | undefined;
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => db } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async (_id: string, options?: typeof filterOptions) => { filterOptions = options; return filter; } } });
mock.module("@/features/flip-finder/server/listing-ai-analysis", { namedExports: { analyzeListingWithAiIfNeeded: async () => undefined } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined, listResaleComps: async () => [] } });

const { runFinderScanPortion, runFinderScanContinuations } = await import("./manual-scan.ts");
const { getFilterResults } = await import("./filter-results.ts");
const { getScanProgress } = await import("./scan-progress.ts");
const { cancelScanRun } = await import("./cancel-scan.ts");
const { SOURCES, EXTERNAL_SOURCE_CONFIGS } = await import("./search-source-registry.ts");
const domy = SOURCES.find((source) => source.id === "domy")!;

function initialize() {
  db = new FakeFacebookSupabase();
  installCanonicalReconciliationRpc(db); // SQL boundary is simulated, not a PostgreSQL concurrency proof.
  db.seed("source_scans", [
    { id: "portion-domy", search_filter_id: filter.id, scan_run_id: runId, source: "domy", status: "pending", started_at: new Date(Date.now()).toISOString(), filter_snapshot: filter, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null },
    { id: "portion-olx", search_filter_id: filter.id, scan_run_id: runId, source: "olx", status: "completed", started_at: new Date(Date.now()).toISOString() },
  ]);
  db.seed("olx_scan_jobs", [{ id: "one-existing-olx-job", scan_run_id: runId, source_scan_id: "portion-olx", status: "completed", result_summary: {} }]);
}

const card = (id: number) => `<article class="propertyBox"><a class="property_link" href="https://domy.pl/mieszkanie/${id}" title="Dwupokojowe mieszkanie na sprzedaż Łódź">Łódź</a><span class="price">439 000 zł</span><span class="area">53m²</span></article>`;

test("real page parser -> persistListing -> canonical wrapper -> Finder advances a saved buffer without refetching committed pages", async () => {
  const originalNow = Date.now;
  const originalFetch = domy.fetch;
  const originalHttp = globalThis.fetch;
  let now = originalNow();
  Date.now = () => now;
  initialize();
  const pages: number[] = [];
  let yieldAfterFirstListing = true;
  const from = db.from.bind(db);
  db.from = (table) => {
    const query = from(table);
    const update = query.update.bind(query);
    query.update = (patch) => {
      if (table === "source_scans" && yieldAfterFirstListing && (patch.filter_snapshot as { _finderCheckpoint?: { offset: number } })?._finderCheckpoint?.offset === 1) {
        yieldAfterFirstListing = false;
        now += 26_000;
      }
      return update(patch);
    };
    return query;
  };
  globalThis.fetch = async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("page") || 1);
      pages.push(page);
      return new Response(page === 1 ? `${card(101)}${card(102)}<a rel="next" href="?page=2">next</a>` : card(103));
    };
  domy.fetch = (criteria, signal, batches) => fetchExternalPortal(EXTERNAL_SOURCE_CONFIGS.find((item) => item.id === "domy")!, criteria, signal, batches);
  try {
    const first = await runFinderScanPortion(runId);
    assert.equal(first.runId, runId);
    assert.equal(first.status, "running");
    assert.equal(first.claimed, 1);
    assert.equal(db.rows("listings").length, 1);
    const saved = structuredClone(db.rows("source_scans")[0]);
    assert.match(String(saved.error_message), /^SOURCE_SLICE_YIELD:/);
    const checkpoint = (saved.filter_snapshot as { _finderCheckpoint: { offset: number; cursor: number; buffer: unknown[] } })._finderCheckpoint;
    assert.equal(checkpoint.offset, 1);
    assert.equal(checkpoint.cursor, 2);
    assert.equal(checkpoint.buffer.length, 2);
    assert.deepEqual(pages, [1]);
    const progress = await getScanProgress(runId);
    assert.equal(progress.totals.created, 1);
    assert.equal(progress.continuation?.ready, true);

    const second = await runFinderScanPortion(runId);
    assert.equal(second.runId, first.runId);
    assert.equal(second.status, "completed");
    assert.deepEqual(pages, [1, 2], "page one and its parsed buffer must never be fetched again");
    assert.equal(db.rows("listings").length, 3);
    assert.equal(db.rows("source_scans")[0].listings_created, 3, "progress is cumulative across portions");
    const finder = await getFilterResults(filter.id);
    assert.ok(finder);
    assert.equal(finder.results.length + finder.reviewResults.length, 3);
    assert.equal(new Set([...finder.results, ...finder.reviewResults].map((item) => item.id)).size, 3);
    assert.equal(db.rows("olx_scan_jobs").length, 1);
    assert.equal(new Set(db.rows("source_scans").map((row) => row.scan_run_id)).size, 1);
    assert.equal(db.accessLog().some((access) => access.name === "facebook_scan_jobs"), false);
    assert.equal(db.accessLog().some((access) => /enqueue.*facebook|claim_facebook/i.test(access.name)), false);
    assert.ok(db.accessLog().some((access) => access.name === "reconcile_canonical_listing_decision"));
    const terminal = await runFinderScanPortion(runId);
    assert.equal(terminal.claimed, 0);
    assert.deepEqual(pages, [1, 2]);
  } finally { Date.now = originalNow; domy.fetch = originalFetch; globalThis.fetch = originalHttp; }
});

test("overlapping requests keep one live owner and fetch once; OLX and Facebook are never queued", async () => {
  initialize();
  const previous = domy.fetch;
  let fetches = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  domy.fetch = async () => { fetches += 1; entered(); await gate; return { listings: [], warnings: [], fetched: 0 }; };
  try {
    const winner = runFinderScanPortion(runId);
    await started;
    const token = db.rows("source_scans")[0].continuation_lease_token;
    const loser = await runFinderScanPortion(runId);
    assert.equal(loser.claimed, 0);
    assert.equal(loser.status, "running");
    assert.equal(db.rows("source_scans")[0].continuation_lease_token, token);
    assert.equal(db.rows("source_scans")[0].status, "running");
    assert.equal(fetches, 1);
    release();
    assert.equal((await winner).status, "completed");
    assert.equal(db.rows("olx_scan_jobs").length, 1);
    assert.equal(db.accessLog().some((access) => access.name === "olx_scan_jobs" || access.name === "facebook_scan_jobs"), false);
  } finally { release(); domy.fetch = previous; }
});

test("a replaced lease rejects old fetched data and preserves the replacement owner's checkpoint and outcome", async () => {
  initialize();
  const previous = domy.fetch;
  let replacement: Record<string, unknown> | undefined;
  domy.fetch = async (_filter, _signal, batches) => {
    const row = db.rows("source_scans")[0];
    Object.assign(row, { continuation_lease_token: "new-owner", continuation_lease_until: new Date(Date.now() + 60_000).toISOString(), filter_snapshot: { _finderCheckpoint: "new-owner-checkpoint" }, matched_count: 99 });
    replacement = structuredClone(row);
    await batches!.onBatch({ listings: [], warnings: [], fetched: 5 }, null);
    return { listings: [], warnings: [], fetched: 5 };
  };
  try {
    await runFinderScanPortion(runId);
    assert.deepEqual(db.rows("source_scans")[0], replacement);
    assert.equal(db.rows("listings").length, 0);
  } finally { domy.fetch = previous; }
});

test("HTTP 403 is terminal, backoff is respected, and terminal sources are never re-fetched", async () => {
  initialize();
  const previous = domy.fetch;
  let fetches = 0;
  domy.fetch = async () => { fetches += 1; throw new Error("HTTP 403"); };
  try {
    const row = db.rows("source_scans")[0];
    row.continuation_next_at = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await runFinderScanPortion(runId)).claimed, 0);
    assert.equal(fetches, 0);
    row.continuation_next_at = null;
    assert.equal((await runFinderScanPortion(runId)).status, "partial");
    assert.equal(db.rows("source_scans")[0].status, "failed");
    assert.match(String(db.rows("source_scans")[0].error_message), /403/);
    assert.equal((await runFinderScanPortion(runId)).claimed, 0);
    assert.equal(fetches, 1);
  } finally { domy.fetch = previous; }
});

test("missing/mixed runs fail closed and a Watcher run is never continued through Finder", async () => {
  initialize();
  await assert.rejects(runFinderScanPortion("invalid"), /INVALID_SCAN_RUN_ID/);
  await assert.rejects(runFinderScanPortion("10000000-0000-4000-8000-000000000099"), /SCAN_RUN_NOT_FOUND/);
  db.rows("source_scans")[1].search_filter_id = "other-filter";
  await assert.rejects(runFinderScanPortion(runId), /SCAN_RUN_INCONSISTENT/);
  db.rows("source_scans")[1].source = "facebook";
  await assert.rejects(runFinderScanPortion(runId), /NOT_FINDER_RUN/);
});

test("a source disabled after reservation ends terminally without a fetch or a perpetual continuation loop", async () => {
  initialize();
  db.rows("source_scans")[0].source = "szybko"; // access verification gate is closed
  const result = await runFinderScanPortion(runId);
  assert.equal(result.claimed, 0);
  assert.equal(result.status, "partial");
  assert.equal(db.rows("source_scans")[0].status, "failed");
  assert.match(String(db.rows("source_scans")[0].error_message), /SOURCE_NOT_ACTIVE/);
  assert.equal((await getScanProgress(runId)).continuation?.ready, false);
  assert.equal(db.accessLog().some((access) => access.name === "facebook_scan_jobs"), false);
});

test("cron includes claim and service-filter loading in its budget and releases an unstarted source immediately", async () => {
  const originalNow = Date.now;
  const previous = domy.fetch;
  let now = originalNow();
  Date.now = () => now;
  initialize();
  let fetches = 0;
  domy.fetch = async () => { fetches += 1; return { listings: [], warnings: [], fetched: 0 }; };
  db.setRpc("claim_finder_scan_source", () => {
    now += 28_000;
    const row = db.rows("source_scans")[0];
    Object.assign(row, { status: "running", continuation_lease_token: "cron-owner", continuation_lease_until: new Date(now + 60_000).toISOString(), continuation_attempt: 1 });
    return { data: [structuredClone(row)], error: null };
  });
  try {
    const result = await runFinderScanContinuations();
    assert.equal(result.claimed, 1);
    assert.equal(result.deferred, 1);
    assert.equal(fetches, 0);
    assert.equal(filterOptions?.supabase, db, "the cron must load the filter using its trusted service client");
    assert.ok(filterOptions?.signal instanceof AbortSignal);
    const row = db.rows("source_scans")[0];
    assert.equal(row.status, "pending");
    assert.equal(row.continuation_lease_token, null);
    assert.match(String(row.error_message), /^SOURCE_BUDGET_EXHAUSTED:/);
    assert.equal(row.scan_run_id, runId);
  } finally { Date.now = originalNow; domy.fetch = previous; }
});

test("cancelling a Finder run clears its lease without touching Watcher jobs, and the old owner cannot finalize", async () => {
  initialize();
  const previous = domy.fetch;
  let cancelled: Record<string, unknown>[] | undefined;
  domy.fetch = async () => {
    const result = await cancelScanRun(runId);
    assert.equal(result.cancelledJobs, 0);
    assert.equal(result.cancelledSources, 1);
    cancelled = structuredClone(db.rows("source_scans"));
    return { listings: [], warnings: [], fetched: 10 };
  };
  try {
    const result = await runFinderScanPortion(runId);
    assert.equal(result.status, "partial");
    assert.deepEqual(db.rows("source_scans"), cancelled);
    assert.equal(db.rows("source_scans")[0].continuation_lease_token, null);
    assert.equal(db.accessLog().some((access) => access.name === "facebook_scan_jobs"), false);
  } finally { domy.fetch = previous; }
});
