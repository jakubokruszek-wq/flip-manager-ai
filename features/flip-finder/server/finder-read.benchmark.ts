/**
 * Reproducible Finder read benchmark (not part of the regular test run).
 *
 *   node --import ./scripts/test-alias-loader.mjs --experimental-strip-types \
 *     --experimental-test-module-mocks --test features/flip-finder/server/finder-read.benchmark.ts
 *
 * It drives the real getFilterResults() and the real dashboard route against
 * an in-memory database shaped like Production on 2026-10-13 (filter "Flip":
 * 3854 memberships = 4 matches + 87 REVIEW + 3763 historical, 6007 scans,
 * 500 comps) and a simulated Supabase link: every PostgREST request costs a
 * round trip (FINDER_BENCH_RTT_MS, default 40 ms) plus transfer time
 * (FINDER_BENCH_MBPS, default 40 Mbit/s). The same file runs unchanged
 * against an older checkout to obtain "before" numbers.
 */
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";

const RTT_MS = Number(process.env.FINDER_BENCH_RTT_MS ?? 40);
const BYTES_PER_MS = (Number(process.env.FINDER_BENCH_MBPS ?? 40) * 1_000_000 / 8) / 1000;
const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
const NOW = Date.parse("2026-10-13T10:00:00.000Z");

type Stats = { queries: number; rows: number; bytes: number; tables: Record<string, number> };
let stats: Stats = { queries: 0, rows: 0, bytes: 0, tables: {} };

/** PostgREST column projection (plain columns, `alias:col->a->>b` JSON paths, `*`), which the in-memory fake ignores. */
function project(rows: unknown, columns: string | null): unknown {
  if (!Array.isArray(rows) || !columns || columns.trim() === "*") return rows;
  const fields = columns.split(",").map((token) => token.trim()).filter(Boolean).map((token) => {
    const [alias, expression] = token.includes(":") ? token.split(":") : [null, token];
    const pathParts = expression.split(/->>?/u);
    return { name: alias ?? pathParts[pathParts.length - 1], path: pathParts };
  });
  return rows.map((row) => Object.fromEntries(fields.map(({ name, path }) => {
    let value: unknown = row;
    for (const key of path) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    return [name, value ?? null];
  })));
}

function measured(db: FakeFacebookSupabase) {
  const wrap = (builder: Record<string, unknown>, table: string): unknown => {
    let columns: string | null = null;
    return new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "select") return (...args: unknown[]) => { columns = typeof args[0] === "string" ? args[0] : null; (value as (...a: unknown[]) => unknown).apply(target, args); return receiver; };
      if (prop === "then") {
        return (onFulfilled: (result: unknown) => unknown, onRejected: (error: unknown) => unknown) => (value as (a: unknown, b: unknown) => Promise<unknown>).call(target, async (raw: { data?: unknown }) => {
          const result = raw && "data" in raw ? { ...raw, data: project(raw.data, columns) } : raw;
          const rows = Array.isArray(result?.data) ? result.data.length : result?.data ? 1 : 0;
          const bytes = JSON.stringify(result?.data ?? null).length;
          stats.queries += 1; stats.rows += rows; stats.bytes += bytes; stats.tables[table] = (stats.tables[table] ?? 0) + rows;
          await new Promise((resolve) => setTimeout(resolve, RTT_MS + bytes / BYTES_PER_MS));
          return onFulfilled(result);
        }, onRejected);
      }
      if (prop === "maybeSingle" || prop === "single") {
        return async () => { stats.queries += 1; stats.tables[table] = (stats.tables[table] ?? 0) + 1; const result = await (value as () => Promise<{ data: unknown }>).call(target); const bytes = JSON.stringify(result.data ?? null).length; stats.rows += 1; stats.bytes += bytes; await new Promise((resolve) => setTimeout(resolve, RTT_MS + bytes / BYTES_PER_MS)); return result; };
      }
      return typeof value === "function" ? (...args: unknown[]) => { const next = (value as (...a: unknown[]) => unknown).apply(target, args); return next === target ? receiver : next; } : value;
    },
    });
  };
  return { from: (table: string) => wrap(db.from(table) as unknown as Record<string, unknown>, table), rpc: db.rpc.bind(db) };
}

const RAW_PAYLOAD = { candidate: { description: "x".repeat(1800), params: Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, value: `v${i}` })), sourcePublishedAt: "2026-09-01T10:00:00Z" } };
function productionDb(): FakeFacebookSupabase {
  const filter = { id: FILTER_ID, name: "Flip", sources: ["otodom", "olx"], city: "Łódź", districts: [], price_min: null, price_max: null, area_min: 31, area_max: 75, rooms: [1, 2, 3, 4], floor_min: null, floor_max: null, exclude_ground_floor: false, exclude_top_floor: false, building_types: ["blok", "apartamentowiec"], ownership_types: [], market_type: null, private_only: false, max_price_per_sqm: 6500, required_keywords: [], excluded_keywords: [], min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null, scan_interval_minutes: 60, is_active: true, last_scanned_at: null, created_at: "2026-07-19T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
  const listings: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  for (let index = 0; index < 3854; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const kind = index < 4 ? "match" : index < 91 ? "review" : "history";
    listings.push({ id, external_listing_id: id, content_hash: id, title: `Mieszkanie ${index}`, price: 269000, area: 47, rooms: kind === "review" && index >= 81 ? null : 2, floor: "2", building_type: kind === "review" && index < 81 ? null : kind === "history" && index < 214 ? "kamienica" : "blok", ownership: null, description: "Opis oferty ".repeat(60), price_per_sqm: null, address: null, city: "Łódź", district: "Śródmieście", images: Array.from({ length: 8 }, (_, i) => `https://img.example/${id}/${i}.jpg`), original_url: `https://www.olx.pl/d/oferta/${id}.html`, source: "olx", status: "active", first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-10-12T00:00:00Z", lifecycle_status: kind === "match" ? "ACTIVE" : kind === "review" ? "REVIEW" : "REJECTED", review_reason: null, missing_fields: [], manual_decision: null, manual_decision_reason: null, archived_at: null, estimated_sale_price: null, estimated_profit: null, estimated_roi: null, flip_score: null, gallery_status: "NOT_REQUESTED", gallery_job_id: null, gallery_requested_at: null, gallery_completed_at: null, gallery_error: null, gallery_total: 0, gallery_persisted_count: 0 });
    memberships.push({ listing_id: id, search_filter_id: FILTER_ID, first_matched_at: "2026-09-01T00:00:00Z", last_matched_at: "2026-10-12T00:00:00Z", is_current_match: kind === "match", match_origin: "scan", match_reasons: kind === "review" ? ["review", index < 81 ? "unknown_buildingType" : "unknown_rooms"] : kind === "history" ? ["max_price_per_sqm"] : [] });
    for (let s = 0; s < 3; s += 1) snapshots.push({ listing_id: id, price: 269000 + s * 1000, captured_at: `2026-10-0${s + 1}T00:00:00Z`, raw_data: RAW_PAYLOAD });
  }
  const scans = Array.from({ length: 6007 }, (_, index) => ({ id: `scan-${index}`, scan_run_id: `run-${index}`, search_filter_id: FILTER_ID, source: index % 2 ? "olx" : "otodom", status: "completed", started_at: new Date(NOW - index * 600_000).toISOString(), finished_at: new Date(NOW - index * 600_000 + 60_000).toISOString(), scanned_count: 100, matched_count: 1, listings_created: 0, new_count: 0, listings_updated: 5, price_drop_count: 0, warnings: [], error_message: null, filter_snapshot: { ...filter, _scanProgress: { lastProgressAt: new Date(NOW - index * 600_000).toISOString(), phase: "completed", completedQueries: 12, expectedQueries: 12 } }, diagnostics: [{ details: "y".repeat(2200) }] }));
  const comps = Array.from({ length: 500 }, (_, index) => ({ id: `comp-${index}`, source: "otodom", external_listing_id: `c${index}`, canonical_url: `https://www.otodom.pl/c${index}`, title: "Komparable", description: "z".repeat(1500), city: "Łódź", district: "Śródmieście", street: null, address: null, latitude: null, longitude: null, price: 400000, area_m2: 50, price_per_m2: 8000, rooms: 2, floor: "2", floors: "4", building_type: "blok", construction_year: 1980, ownership: null, balcony: true, elevator: false, parking: false, renovation_status: "RENOVATED", renovation_confidence: "HIGH", finish_level: null, listing_created_at: null, first_seen_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-10-12T00:00:00Z", active: true, seller_type: null, fingerprint: null, outlier_reason: null, evidence: { signals: [] } }));
  return new FakeFacebookSupabase().seed("search_filters", [filter]).seed("listings", listings).seed("listing_filter_matches", memberships).seed("listing_snapshots", snapshots).seed("source_scans", scans).seed("resale_comps", comps).seed("finder_listing_identity_groups", []).seed("finder_listing_identity_decisions", []).seed("finder_building_type_confirmations", []);
}

const db = productionDb();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => measured(db) } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => measured(db) } });
mock.module("@/features/auth/operator", { namedExports: { requireOperator: async () => ({ id: "operator-bench", email: "operator@example.test" }), operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }) } });
const { getFilterResults } = await import("./filter-results.ts");
const { GET: dashboardRoute } = await import("../../../app/api/flip-finder/search-filters/route.ts");
const { GET: resultsRoute } = await import("../../../app/api/flip-finder/search-filters/[id]/results/route.ts");

async function measure(label: string, run: () => Promise<unknown>) {
  const samples: Array<Stats & { ms: number; responseBytes: number }> = [];
  for (let i = 0; i < 3; i += 1) {
    stats = { queries: 0, rows: 0, bytes: 0, tables: {} };
    const started = performance.now();
    const response = await run();
    const ms = performance.now() - started;
    const responseBytes = response instanceof Response ? (await response.text()).length : JSON.stringify(response ?? null).length;
    samples.push({ ...stats, ms, responseBytes });
  }
  const best = samples.sort((a, b) => a.ms - b.ms)[1];
  console.log(`BENCH ${label}: ${best.ms.toFixed(0)} ms | queries ${best.queries} | rows read ${best.rows} | DB bytes ${(best.bytes / 1024).toFixed(0)} KiB | response ${(best.responseBytes / 1024).toFixed(0)} KiB | rows by table ${JSON.stringify(best.tables)}`);
}

test("Finder read benchmark", { timeout: 600_000 }, async () => {
  console.log(`BENCH model: RTT ${RTT_MS} ms per request, ${(BYTES_PER_MS * 8 / 1000).toFixed(0)} Mbit/s`);
  await measure("results (getFilterResults, active)", () => getFilterResults(FILTER_ID, false, NOW, "operator-bench"));
  await measure("results route (active)", () => resultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) }));
  await measure("dashboard route (filter list)", () => dashboardRoute());
  await measure("archive route (first page)", () => resultsRoute(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results?view=archive`), { params: Promise.resolve({ id: FILTER_ID }) }));
});
