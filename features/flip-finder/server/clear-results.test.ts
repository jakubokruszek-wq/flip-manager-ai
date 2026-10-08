import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "@/features/facebook-watcher/server/facebook-fake-supabase.ts";

const filterId = "10000000-0000-4000-8000-000000000001";
const otherFilterId = "20000000-0000-4000-8000-000000000002";
const filter = {
  id: filterId, name: "Flip", sources: ["otodom"], city: "Łódź", districts: [], priceMin: null, priceMax: null,
  areaMin: 35, areaMax: null, rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false,
  excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false,
  maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
} as never;

let db = new FakeFacebookSupabase();
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async (id: string) => id === filterId ? filter : null } });
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => ({ id: "operator-clear-test", email: "operator@example.test" }),
  operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
} });

const { ClearResultsConflictError, clearFilterResults } = await import("./clear-results.ts");
const { getFilterResults } = await import("./filter-results.ts");
const { POST: clearResultsRoute } = await import("../../../app/api/flip-finder/search-filters/[id]/clear-results/route.ts");
const { GET: getResultsRoute } = await import("../../../app/api/flip-finder/search-filters/[id]/results/route.ts");

function makeListing(id: string, review = false): Record<string, unknown> {
  return {
    id, source: "otodom", external_listing_id: id, content_hash: id, title: `Mieszkanie ${id}`, price: 400000,
    area: review ? null : 50, rooms: 2, floor: "1", building_type: "blok", ownership: "pełna własność",
    description: "Oferta sprzedaży", price_per_sqm: 8000, address: "Łódź", city: "Łódź", district: null,
    images: [], original_url: `https://www.otodom.pl/pl/oferta/${id}`, status: "active",
    first_seen_at: "2026-10-06T10:00:00.000Z", last_seen_at: "2026-10-06T10:00:00.000Z",
    lifecycle_status: review ? "REVIEW" : "ACTIVE", review_reason: review ? "unknown_area" : null,
    missing_fields: review ? ["area"] : [], manual_decision: id === "review-0" ? "ACCEPTED" : null,
    manual_decision_reason: null, archived_at: null,
  };
}

function membership(listingId: string, review = false, searchFilterId = filterId): Record<string, unknown> {
  return {
    id: `${searchFilterId}:${listingId}`, listing_id: listingId, search_filter_id: searchFilterId,
    first_matched_at: "2026-10-06T10:00:00.000Z", last_matched_at: "2026-10-06T10:00:00.000Z",
    is_current_match: !review, match_origin: "scan", match_reasons: review ? ["review", "unknown_area"] : [],
  };
}

function initialize(listings: Record<string, unknown>[], memberships: Record<string, unknown>[], sourceScans: Record<string, unknown>[] = []) {
  db = new FakeFacebookSupabase()
    .seed("listings", listings)
    .seed("listing_filter_matches", memberships)
    .seed("listing_snapshots", listings.map((row) => ({ listing_id: row.id, price: row.price, captured_at: "2026-10-06T10:00:00.000Z", raw_data: { sourcePublishedAt: "2026-10-06T09:00:00.000Z" } })))
    .seed("search_filters", [])
    .seed("source_scans", sourceScans)
    .seed("resale_comps", []);
}

test("clearing zero MATCHED plus 22 REVIEW rows hides both result sections without changing listing, history, CRM decision, or another filter", async () => {
  const listings = Array.from({ length: 22 }, (_, i) => makeListing(`review-${i}`, true));
  const memberships = listings.map((row) => membership(String(row.id), true));
  memberships.push(membership("review-0", false, otherFilterId));
  initialize(listings, memberships);
  const listingsBefore = structuredClone(db.rows("listings"));
  const snapshotsBefore = structuredClone(db.rows("listing_snapshots"));

  const before = await getFilterResults(filterId);
  assert.equal(before?.results.length, 0);
  assert.equal(before?.reviewResults.length, 22);
  const cleared = await clearFilterResults(filterId);
  assert.equal(cleared.archivedCount, 22);
  const after = await getFilterResults(filterId);
  assert.equal(after?.results.length, 0);
  assert.equal(after?.reviewResults.length, 0);
  assert.equal(after?.counts.active, 0);
  assert.equal(after?.counts.review, 0);
  const afterHistory = await getFilterResults(filterId, true);
  assert.equal(afterHistory?.archivedResults.length, 22, "cleared rows remain accessible in this filter's history projection");
  assert.deepEqual(db.rows("listings"), listingsBefore, "canonical listings, manual decisions and lifecycle stay untouched");
  assert.deepEqual(db.rows("listing_snapshots"), snapshotsBefore, "price/photo history remains untouched");
  const otherMembership = db.rows("listing_filter_matches").find((row) => row.search_filter_id === otherFilterId);
  assert.equal(otherMembership?.is_current_match, true, "another filter's row must not be cleared");
  assert.equal(db.rows("listing_filter_matches").filter((row) => row.search_filter_id === filterId && (row.match_reasons as string[]).includes("finder_cleared")).length, 22);
});

test("route E2E: confirmation POST writes per-filter tombstones and the subsequent results GET returns zero MATCHED and REVIEW", async () => {
  const listings = [makeListing("route-matched"), makeListing("route-review-a", true), makeListing("route-review-b", true)];
  initialize(listings, listings.map((row) => membership(String(row.id), row.id !== "route-matched")));

  const beforeResponse = await getResultsRoute(
    new Request(`http://localhost/api/flip-finder/search-filters/${filterId}/results`),
    { params: Promise.resolve({ id: filterId }) },
  );
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json() as { results: unknown[]; reviewResults: unknown[] };
  assert.equal(before.results.length, 1);
  assert.equal(before.reviewResults.length, 2);

  const clearResponse = await clearResultsRoute(
    new Request(`http://localhost/api/flip-finder/search-filters/${filterId}/clear-results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ id: filterId }) },
  );
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(await clearResponse.json(), { ok: true, archivedCount: 3 });
  assert.equal(db.rows("listing_filter_matches").filter((row) => row.search_filter_id === filterId && (row.match_reasons as string[]).includes("finder_cleared")).length, 3);

  const afterResponse = await getResultsRoute(
    new Request(`http://localhost/api/flip-finder/search-filters/${filterId}/results`),
    { params: Promise.resolve({ id: filterId }) },
  );
  assert.equal(afterResponse.status, 200);
  const after = await afterResponse.json() as { results: unknown[]; reviewResults: unknown[]; counts: { active: number; review: number } };
  assert.deepEqual(after.results, []);
  assert.deepEqual(after.reviewResults, []);
  assert.deepEqual(after.counts, { active: 0, review: 0, archived: 0 });
});

test("clearing more than 2000 visible memberships writes deterministic chunks of at most 200 and is idempotent", async () => {
  const listings = Array.from({ length: 2_105 }, (_, i) => makeListing(`mixed-${String(i).padStart(4, "0")}`, i % 2 === 1));
  const memberships = listings.map((row, i) => membership(String(row.id), i % 2 === 1));
  initialize(listings, memberships);
  const before = await getFilterResults(filterId);
  assert.equal(before?.results.length, 1_053);
  assert.equal(before?.reviewResults.length, 1_052);
  const updateChunkSizes: number[] = [];
  const originalFrom = db.from.bind(db);
  Object.defineProperty(db, "from", {
    configurable: true,
    value: (table: string) => {
      const query = originalFrom(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
      if (table === "listing_filter_matches") {
        const originalUpdate = query.update.bind(query);
        const originalIn = query.in.bind(query);
        let updating = false;
        query.update = (payload: unknown) => { updating = true; originalUpdate(payload); return query; };
        query.in = (column: unknown, values: unknown) => {
          if (updating && column === "listing_id" && Array.isArray(values)) updateChunkSizes.push(values.length);
          originalIn(column, values);
          return query;
        };
      }
      return query;
    },
  });

  const cleared = await clearFilterResults(filterId);
  assert.equal(cleared.archivedCount, 2_105);
  assert.ok(updateChunkSizes.length > 1);
  assert.ok(updateChunkSizes.every((size) => size > 0 && size <= 200), `writes must use no more than 200 IDs per update: ${updateChunkSizes}`);
  assert.equal(updateChunkSizes.reduce((sum, size) => sum + size, 0), 2_105);
  const after = await getFilterResults(filterId);
  assert.equal(after?.total, 0, "the next read must keep the MATCHED section empty, including IDs after the first read page");
  assert.equal(after?.reviewResults.length, 0, "the next read must keep the REVIEW section empty, including IDs after the first read page");
  assert.deepEqual(await clearFilterResults(filterId), { archivedCount: 0 }, "repeating a successful clear is a no-op");
  assert.equal(db.rows("listing_filter_matches").filter((row) => (row.match_reasons as string[]).includes("finder_cleared")).length, 2_105);
});

test("an active Finder source scan refuses clearing with a conflict and changes no rows", async () => {
  const listing = makeListing("active-run-listing");
  initialize([listing], [membership("active-run-listing")], [{ id: "scan-1", search_filter_id: filterId, source: "otodom", status: "running" }]);
  const before = structuredClone(db.rows("listing_filter_matches"));
  await assert.rejects(clearFilterResults(filterId), ClearResultsConflictError);
  assert.deepEqual(db.rows("listing_filter_matches"), before);
});
