import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { performance } from "node:perf_hooks";
// Loaded before the registry mock below: the real portal configs and the real
// Oferty.net adapter/parser are exercised, only the network is simulated.
import { EXTERNAL_SOURCE_CONFIGS } from "@/features/flip-finder/server/search-source-registry";
import { fetchExternalPortal } from "@/features/flip-finder/external-source-adapters";

/*
 * Representative, offline performance model of one Radar run. Nothing here
 * contacts a portal or Supabase.
 *
 * - Oferty.net runs through the REAL adapter and parser: 5 result pages x 30
 *   offers, each needing its detail page (the run's critical path), plus 2
 *   offers per later page that were re-listed while the run was in progress.
 * - Four list-only portals deliver 5 pages x 30 offers each.
 * - Adresowo answers with a CAPTCHA (terminal, never bypassed) and one portal
 *   always times out (bounded by the no-progress limit).
 * - Network and Supabase latency are modelled; model time runs SCALE times
 *   faster than wall time. Every portion is followed by a modelled hand-off
 *   (lease release, continuation request, cold start, claim).
 *
 * RADAR_PERF_BASELINE=1 only prints the measurements, so the same file can be
 * run against the code before the optimisation for the BEFORE/AFTER table.
 */
const SCALE = 20;
const PROFILES = {
  normal: { listMs: 1_500, detailMs: 1_000, contextMs: 600, dbMs: 40, handOffMs: 3_000, slowPortalTimeoutMs: 20_000 },
  // Slow portals and a slow database round trip.
  slow: { listMs: 3_000, detailMs: 2_500, contextMs: 1_500, dbMs: 70, handOffMs: 5_000, slowPortalTimeoutMs: 20_000 },
} as const;
const PROFILE = process.env.RADAR_PERF_PROFILE === "slow" ? "slow" : "normal";
const MODEL = { ...PROFILES[PROFILE], handOffMs: Number(process.env.RADAR_PERF_HANDOFF_MS ?? PROFILES[PROFILE].handOffMs) };
const BASELINE = process.env.RADAR_PERF_BASELINE === "1";
const LANES = Number(process.env.RADAR_PERF_LANES ?? 3);
const ownerId = "owner-radar-performance";
type Row = Record<string, unknown>;
type Counters = { list: number; detail: number; context: number; db: number; checkpoints: number };

const sleepModel = (modelMs: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.round(modelMs / SCALE))));

function fakeDb(counters: Counters) {
  const tables: Record<string, Row[]> = { price_radar_runs: [], price_radar_listings: [], olx_scan_jobs: [], price_radar_district_queue: [], price_radar_verification_queue: [] };
  let seq = 0;
  const latency = async () => { counters.db += 1; await sleepModel(MODEL.dbMs); };
  return {
    tables,
    async rpc(name: string, args: Row) {
      await latency();
      if (name === "claim_price_radar_run") {
        const row = { id: `run-${++seq}`, owner_id: args.p_owner_id, lease_token: `lease-${seq}`, lease_until: new Date(Date.now() + 3_600_000).toISOString(), started_at: new Date().toISOString(), finished_at: null, status: "running", scanned_count: 0, qualified_count: 0, error_message: null, source_statuses: {}, checkpoint: args.p_initial_checkpoint };
        tables.price_radar_runs.push(row);
        return { data: [{ ...row, run_id: row.id }], error: null };
      }
      if (name === "checkpoint_price_radar_run") {
        counters.checkpoints += 1;
        const row = tables.price_radar_runs.find((entry) => entry.id === args.p_run_id && entry.lease_token === args.p_lease_token && entry.status === "running");
        if (!row) return { data: false, error: null };
        Object.assign(row, { checkpoint: structuredClone(args.p_checkpoint), source_statuses: args.p_source_statuses, scanned_count: args.p_scanned_count, qualified_count: args.p_qualified_count, status: args.p_status, error_message: args.p_error_message });
        if (["completed", "partial", "failed"].includes(String(args.p_status))) Object.assign(row, { finished_at: new Date().toISOString() });
        else row.lease_until = new Date(Date.now() + 3_600_000).toISOString();
        return { data: true, error: null };
      }
      if (name === "persist_price_radar_listing") {
        const candidate = args.p_listing as Row;
        let row = tables.price_radar_listings.find((entry) => entry.source === candidate.source && entry.external_listing_id === candidate.external_listing_id);
        if (!row) { row = { id: `listing-${++seq}`, owner_id: args.p_owner_id }; tables.price_radar_listings.push(row); }
        Object.assign(row, candidate, { status: "active" });
        return { data: row.id, error: null };
      }
      if (name === "upsert_price_radar_district_queue_candidate" || name === "upsert_price_radar_verification_candidate") {
        const table = name.includes("district") ? tables.price_radar_district_queue : tables.price_radar_verification_queue;
        const candidate = args.p_candidate as Row;
        let row = table.find((entry) => entry.source === candidate.source && entry.external_listing_id === candidate.external_listing_id);
        if (!row) { row = { id: `queue-${++seq}`, owner_id: args.p_owner_id, status: "pending", operator_decision: null }; table.push(row); }
        Object.assign(row, candidate);
        return { data: row.id, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(row: Row) => boolean> = [];
      let payload: Row | null = null;
      const matched = () => rows.filter((row) => filters.every((filter) => filter(row)));
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        is: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        lte: (key: string, value: string) => { filters.push((row) => typeof row[key] === "string" && Date.parse(String(row[key])) <= Date.parse(value)); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        update: (value: Row) => { payload = value; return builder; },
        insert: (value: Row) => { payload = { id: `row-${++seq}`, status: "queued", ...value }; return builder; },
        range: async () => { await latency(); return { data: matched(), error: null }; },
        maybeSingle: async () => {
          await latency();
          const row = matched()[0] ?? null;
          if (payload && row) Object.assign(row, payload);
          return { data: row, error: null };
        },
        single: async () => {
          await latency();
          if (payload && !rows.includes(payload)) { rows.push(payload); return { data: payload, error: null }; }
          return { data: matched()[0] ?? null, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => latency().then(() => {
          if (payload) for (const row of matched()) Object.assign(row, payload);
          return { data: matched(), error: null };
        }).then(resolve, reject),
      };
      return builder;
    },
  };
}

// ---- Oferty.net: real adapter, simulated pages ------------------------------
const OFERTY_PAGES = 5;
const OFFERS_PER_PAGE = 30;
const RELISTED_PER_PAGE = 2;
function ofertyOfferId(page: number, index: number): number {
  // The first offers of a later page are offers from the previous page that
  // moved down while the run was in progress (new offers were published).
  if (page > 1 && index < RELISTED_PER_PAGE) return 1_540_000_000 + (page - 1) * 100 + (OFFERS_PER_PAGE - 1 - index);
  return 1_540_000_000 + page * 100 + index;
}
function ofertyListPage(page: number): string {
  const rows = Array.from({ length: OFFERS_PER_PAGE }, (_, index) => {
    const id = ofertyOfferId(page, index);
    const url = `https://www.oferty.net/mieszkanie-na-sprzedaz-baluty-teofilow-45m2-2-pokoje-fb,${id}`;
    return `<tr class="property"><td class="cell_photo"><img alt="Mieszkanie na sprzeda&#380; &#321;&oacute;d&#378;, Ba&#322;uty" src="https://cdn.example/${id}.jpg"></td><td class="cell_location"><a href="${url}" title="Mieszkanie na sprzeda&#380;, &#321;&oacute;d&#378;, Ba&#322;uty">Mieszkanie &#321;&oacute;d&#378;, Ba&#322;uty</a></td><td class="cell_area">45 m2</td><td class="cell_rooms">2</td><td class="cell_price">${419_000 + index * 1_000}</td><td class="cell_added_at">2026-10-01</td></tr>`;
  }).join("");
  const next = page < OFERTY_PAGES ? `<li class="navigate"><div><a>${OFERTY_PAGES}</a></div></li>` : "";
  return `<table>${rows}</table><div class="paginator"><li class="navigate current"><div><a>${page}</a></div></li>${next}</div>`;
}
function ofertyDetailPage(id: string): string {
  const price = 419_000 + (Number(id) % 100) * 1_000;
  return `<title>Mieszkanie na sprzeda&#380; - &#321;anowa Teofil&oacute;w, Ba&#322;uty, &#321;&oacute;d&#378; | oferty.net</title>
<div class="header"><span>Mieszkanie na sprzeda&#380;</span><h1>&#322;&oacute;dzkie, &#321;&oacute;d&#378;, Ba&#322;uty, Teofil&oacute;w, &#321;anowa</h1><h3>Pow.: 45 m2, Cena: ${price.toLocaleString("pl-PL").replace(/\s/gu, " ")} PLN</h3></div>
<div class="param"><dl><dt>Powierzchnia u&#380;ytkowa</dt><dd>45 m2</dd><dt>Liczba pokoi</dt><dd>2</dd><dt>Typ budynku</dt><dd>BLOK</dd><dt>Rynek pierwotny</dt><dd>Nie</dd></dl></div>
<div class="description"><p>Mieszkanie po generalnym remoncie zako&#324;czonym w 2025 roku, nowe instalacje, gotowe do wprowadzenia.</p></div>`;
}
function withUrl(body: string, url: string): Response {
  const response = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function installFakeNetwork(counters: Counters): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith("oferty.net")) throw new Error(`unexpected network request ${url.hostname}`);
    if (/^\/mieszkania,lodz\/?$/u.test(url.pathname)) {
      counters.context += 1;
      await sleepModel(MODEL.contextMs);
      return withUrl(`<script>$('#locationSelector').myOfertyLocationSelector([10, 1410, 331410]);</script>`, url.toString());
    }
    if (url.pathname === "/mieszkania/szukaj") {
      counters.list += 1;
      await sleepModel(MODEL.listMs);
      return withUrl(ofertyListPage(Number(url.searchParams.get("page") ?? "1")), url.toString());
    }
    counters.detail += 1;
    await sleepModel(MODEL.detailMs);
    return withUrl(ofertyDetailPage(url.pathname.match(/,(\d+)$/u)?.[1] ?? "0"), url.toString());
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

// ---- Other portals: list-only, CAPTCHA, always-timing-out -------------------
type Batches = { cursor?: number; onBatch(batch: { listings: unknown[]; warnings: string[]; fetched: number }, next: number | null): Promise<void> };
function listListing(source: string, page: number, index: number) {
  const id = `${source}-${page}-${index}`;
  return {
    source, externalListingId: id, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`,
    title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty", buildingType: "blok", floor: null,
    locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null, rawPayload: { detailVerified: true, marketType: "secondary" }, contentHash: `hash-${id}`,
  };
}
function fakePortal(id: string, counters: Counters) {
  return {
    id, label: id,
    fetch: async (_criteria: unknown, signal?: AbortSignal, batches?: Batches) => {
      if (id === "adresowo") { counters.list += 1; await sleepModel(MODEL.listMs); throw new Error("HTTP 403 CAPTCHA_OR_ACCESS_DENIED"); }
      if (id === "allegro_lokalnie") { counters.list += 1; await sleepModel(MODEL.slowPortalTimeoutMs); const error = new Error("The operation was aborted due to timeout"); error.name = "TimeoutError"; throw error; }
      for (let page = batches?.cursor ?? 1; page <= 5; page += 1) {
        if (signal?.aborted) throw new Error(`${id}: request aborted.`);
        counters.list += 1;
        await sleepModel(MODEL.listMs);
        await batches!.onBatch({ listings: Array.from({ length: OFFERS_PER_PAGE }, (_, index) => listListing(id, page, index)), warnings: [], fetched: OFFERS_PER_PAGE }, page < 5 ? page + 1 : null);
      }
      return { listings: [], warnings: [], fetched: 0 };
    },
  };
}

const LIST_PORTALS = ["morizon", "gratka", "domy", "nieruchomosci_online"];
const SOURCES_UNDER_TEST = ["oferty_net", ...LIST_PORTALS, "adresowo", "allegro_lokalnie"];
let currentCounters: Counters = { list: 0, detail: 0, context: 0, db: 0, checkpoints: 0 };
const ofertyConfig = EXTERNAL_SOURCE_CONFIGS.find((config) => config.id === "oferty_net")!;
const registry = () => [
  { id: "oferty_net", label: "Oferty.net", fetch: (criteria: { city: string | null; areaMin?: number | null; areaMax?: number | null; rooms?: number[] }, signal?: AbortSignal, batches?: unknown) => fetchExternalPortal(ofertyConfig, criteria, signal, batches as never) },
  ...[...LIST_PORTALS, "adresowo", "allegro_lokalnie"].map((id) => fakePortal(id, currentCounters)),
];
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("performance test injects its own DB"); } } });
mock.module("@/features/flip-finder/server/search-source-registry", { namedExports: {
  SOURCES: [], EXTERNAL_SOURCE_CONFIGS, slugifyCity: () => "lodz",
  activeSources: (filter: { sources: string[] }) => registry().filter((source) => filter.sources.includes(source.id)),
} });
const collect = await import("./collect.ts");

type Measurement = { modelMinutes: number; portions: number; scanned: number; qualified: number; uniqueOffers: number; requests: Counters; statuses: Record<string, unknown>; errors: Record<string, string>; offersPerMinute: number; sourceMetrics?: unknown };

async function simulateRun(): Promise<Measurement> {
  currentCounters = { list: 0, detail: 0, context: 0, db: 0, checkpoints: 0 };
  const counters = currentCounters;
  const restore = installFakeNetwork(counters);
  try {
    const db = fakeDb(counters);
    const claim = await collect.claimOrCreateRadarRun(ownerId, SOURCES_UNDER_TEST as never, db as never, { areaMin: null, areaMax: null, rooms: [], minPricePerSqm: null, districts: [], qualityRulesVersion: 2 });
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    const input = { runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! };
    const timing = { parallelSources: LANES, portionBudgetMs: 42_000 / SCALE, yieldMarginMs: 8_000 / SCALE, minSliceMs: 10_000 / SCALE, detailReserveMs: 8_000 / SCALE, checkpointIntervalMs: 3_000 / SCALE, httpRunLimitMs: 30 * 60_000 / SCALE };
    let portions = 0;
    let wallMs = 0;
    let result: Awaited<ReturnType<typeof collect.runRadarCollectionPortion>>;
    do {
      const startedAt = performance.now();
      // The extra argument is ignored by code that predates scaled timing.
      result = await (collect.runRadarCollectionPortion as (...args: unknown[]) => ReturnType<typeof collect.runRadarCollectionPortion>)(input, db, timing);
      wallMs += performance.now() - startedAt;
      portions += 1;
    } while (result.status === "running" && portions < 400);
    const modelMs = wallMs * SCALE + (portions - 1) * MODEL.handOffMs;
    const checkpoint = db.tables.price_radar_runs[0]!.checkpoint as { progress?: { metrics?: unknown } };
    return {
      modelMinutes: Math.round(modelMs / 6_000) / 10,
      portions,
      scanned: result.scannedCount,
      qualified: result.qualifiedCount,
      uniqueOffers: db.tables.price_radar_listings.length,
      requests: { ...counters },
      statuses: result.sourceStatuses,
      errors: Object.fromEntries(Object.entries(result.sourceErrors).map(([source, message]) => [source, message.split(":")[0]!])),
      offersPerMinute: Math.round(result.scannedCount / (modelMs / 60_000)),
      sourceMetrics: checkpoint.progress?.metrics,
    };
  } finally { restore(); }
}

test("performance model of a representative Radar run (offline, no Production)", { timeout: 300_000 }, async () => {
  const measured = await simulateRun();
  const { sourceMetrics, ...summary } = measured;
  console.log(`RADAR_PERF ${BASELINE ? "BEFORE" : "AFTER"} profile=${PROFILE} handOffMs=${MODEL.handOffMs} lanes=${BASELINE ? 1 : LANES} ${JSON.stringify(summary)}`);
  if (sourceMetrics) console.log(`RADAR_PERF_SOURCES ${JSON.stringify(sourceMetrics)}`);
  if (BASELINE) return;

  const uniqueOferty = OFERTY_PAGES * OFFERS_PER_PAGE - (OFERTY_PAGES - 1) * RELISTED_PER_PAGE;
  const target = PROFILE === "slow" ? 25 : 15;
  assert.ok(measured.modelMinutes <= target, `a ${PROFILE} run of the available HTTP portals takes at most ${target} model minutes (took ${measured.modelMinutes})`);
  assert.equal(measured.requests.detail, uniqueOferty, "every unique offer's detail page is fetched exactly once; re-listed offers are not fetched again");
  const ofertyMetrics = (measured.sourceMetrics as { sources: Record<string, { listRequests: number; contextRequests: number }> }).sources.oferty_net!;
  assert.ok(ofertyMetrics.contextRequests <= 1, `the city location context is read once per run (${ofertyMetrics.contextRequests})`);
  assert.ok(ofertyMetrics.listRequests <= Math.ceil(measured.requests.detail / 3), `result pages are no longer re-read for every three details (${ofertyMetrics.listRequests} list requests for ${measured.requests.detail} details)`);
  assert.equal(measured.scanned, uniqueOferty + LIST_PORTALS.length * 5 * OFFERS_PER_PAGE, "no offer is skipped to save time and none is counted twice");
  assert.equal(measured.statuses.oferty_net, "completed");
  for (const portal of LIST_PORTALS) assert.equal(measured.statuses[portal], "completed");
  assert.equal(measured.statuses.adresowo, "failed");
  assert.equal(measured.errors.adresowo, "TERMINAL_ACCESS_ERROR", "CAPTCHA is reported, never bypassed or retried");
  assert.equal(measured.statuses.allegro_lokalnie, "failed");
  assert.equal(measured.errors.allegro_lokalnie, "RADAR_SOURCE_NO_PROGRESS_LIMIT");
  const metrics = measured.sourceMetrics as { httpActiveMs: number; portions: number; sources: Record<string, { detailRequests: number; listRequests: number; fetched: number }> };
  assert.equal(metrics.sources.oferty_net!.detailRequests, measured.requests.detail, "the run's own profile counts every request");
  assert.equal(metrics.portions, measured.portions);
});

test("the HTTP part of a run ends after its active time limit with honest partial coverage", { timeout: 300_000, skip: BASELINE }, async () => {
  currentCounters = { list: 0, detail: 0, context: 0, db: 0, checkpoints: 0 };
  const restore = installFakeNetwork(currentCounters);
  try {
    const db = fakeDb(currentCounters);
    const claim = await collect.claimOrCreateRadarRun(ownerId, ["oferty_net", "morizon"] as never, db as never, { areaMin: null, areaMax: null, rooms: [], minPricePerSqm: null, districts: [], qualityRulesVersion: 2 });
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    const input = { runId: claim.run.id, ownerId, leaseToken: claim.run.leaseToken! };
    // A limit far below the work needed (2 model minutes) stands in for 30.
    const timing = { parallelSources: LANES, portionBudgetMs: 42_000 / SCALE, yieldMarginMs: 8_000 / SCALE, minSliceMs: 10_000 / SCALE, detailReserveMs: 8_000 / SCALE, checkpointIntervalMs: 3_000 / SCALE, httpRunLimitMs: 2 * 60_000 / SCALE };
    let result;
    let portions = 0;
    do { result = await collect.runRadarCollectionPortion(input, db as never, timing); portions += 1; } while (result.status === "running" && portions < 100);
    assert.notEqual(result.status, "running", "the run ends instead of working indefinitely");
    assert.equal(result.sourceStatuses.oferty_net, "partial", "already collected offers are kept and reported as partial coverage");
    assert.match(result.sourceErrors.oferty_net ?? "", /^RADAR_HTTP_TIME_LIMIT:/u);
    assert.ok(result.scannedCount > 0);
    assert.ok(db.tables.price_radar_listings.length > 0, "saved results are preserved");
  } finally { restore(); }
});
