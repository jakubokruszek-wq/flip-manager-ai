import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[]) {
  return {
    from(table: string) {
      assert.equal(table, "price_radar_listings");
      const filters: Array<(row: Row) => boolean> = [];
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((item) => item[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((item) => values.includes(item[key])); return builder; },
        order: () => builder,
        range: async () => ({ data: rows.filter((item) => filters.every((filter) => filter(item))), error: null }),
      };
      return builder;
    },
  };
}

let currentDb: ReturnType<typeof fakeDb>;
const { getRadarResults } = await import("./radar-results.ts");
const OWNER = "owner-1";

function row(overrides: Row = {}): Row {
  return {
    id: "listing-1", owner_id: OWNER, source: "domiporta", external_listing_id: "ext-1", original_url: "https://domiporta.pl/1", normalized_url: "https://domiporta.pl/1",
    title: "Mieszkanie", description: null, price: 450_000, area: 50, price_per_sqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "hash-1",
    first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-05T00:00:00Z", published_at: null, source_updated_at: null, collected_at: "2026-10-05T00:00:00Z", cross_source_identity: null, status: "active", excluded_at: null, excluded_reason: null,
    ...overrides,
  };
}

const baseFilters = { districts: [], market: "both" as const, areaMin: null, areaMax: null, rooms: [], sources: [], minPricePerSqm: null };

test("reads active listings, computes stats, and returns them visible", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-2", external_listing_id: "ext-2", original_url: "https://domiporta.pl/2", normalized_url: "https://domiporta.pl/2", price: 500_000, price_per_sqm: 10_000 })]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 2);
  assert.equal(payload.excludedListings.length, 0);
  assert.equal(payload.stats.length, 1);
  assert.equal(payload.stats[0].averagePricePerSqm, null, "a two-row sample must not publish a reference average");
  assert.equal(payload.stats[0].sampleSize, 2);
});

test("an excluded listing is reported separately and never counted in stats", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-2", external_listing_id: "ext-2", original_url: "https://domiporta.pl/2", normalized_url: "https://domiporta.pl/2", excluded_at: "2026-10-02T00:00:00Z", excluded_reason: "duplikat" })]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.excludedListings.length, 1);
  assert.equal(payload.excludedListings[0].excludedReason, "duplikat");
  assert.equal(payload.stats[0].sampleSize, 1, "the excluded listing must not inflate the sample");
});

test("within-portal duplicates (same source, same confirmed URL) collapse to one card via the shared identity resolver", async () => {
  currentDb = fakeDb([
    row({ id: "listing-a", external_listing_id: "old-id", last_seen_at: "2026-10-01T00:00:00Z" }),
    row({ id: "listing-b", external_listing_id: "old-id", normalized_url: "https://domiporta.pl/1", last_seen_at: "2026-10-05T00:00:00Z" }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 1, "two rows sharing the same confirmed normalized_url for the same source must render as one listing");
});

test("different listings with identical price, area, district and rooms remain separate without a positive identity proof", async () => {
  currentDb = fakeDb([
    row({ id: "listing-domiporta", source: "domiporta", external_listing_id: "d-1", first_seen_at: "2026-10-01T00:00:00Z" }),
    row({ id: "listing-olx", source: "olx", external_listing_id: "o-1", first_seen_at: "2026-10-03T00:00:00Z" }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 2, "the same tuple is not evidence that two portal listings are one dwelling");
});

test("cross-portal listings that merely share a similar title or address but differ in price/area/rooms are NEVER merged", async () => {
  currentDb = fakeDb([
    row({ id: "listing-domiporta", source: "domiporta", external_listing_id: "d-2", title: "Ładne mieszkanie w Bałutach", price: 450_000 }),
    row({ id: "listing-olx", source: "olx", external_listing_id: "o-2", title: "Ładne mieszkanie w Bałutach", price: 455_000 }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 2, "a different confirmed price must keep these as two distinct listings, regardless of the similar title");
});

test("two genuinely different apartments from the same portal sharing identical price/area/district/rooms are NOT collapsed -- cross-portal collapsing only applies across different sources", async () => {
  currentDb = fakeDb([
    row({ id: "listing-1", source: "domiporta", external_listing_id: "d-3", original_url: "https://domiporta.pl/d-3", normalized_url: "https://domiporta.pl/d-3" }),
    row({ id: "listing-2", source: "domiporta", external_listing_id: "d-4", original_url: "https://domiporta.pl/d-4", normalized_url: "https://domiporta.pl/d-4" }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 2);
});

test("market=secondary/primary narrows results without mixing the stats groups", async () => {
  currentDb = fakeDb([
    row({ id: "listing-1" }),
    row({ id: "listing-2", external_listing_id: "ext-2", market_type: "primary", renovation_status: "turnkey_finish", price_per_sqm: 14_000 }),
  ]);
  const payload = await getRadarResults(OWNER, { ...baseFilters, market: "secondary" }, currentDb as never);
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.listings[0].marketType, "secondary");
});

test("the optional minimum asking price per square metre filters cards and matching stats together", async () => {
  currentDb = fakeDb([
    row({ id: "below", external_listing_id: "below", original_url: "https://domiporta.pl/below", normalized_url: "https://domiporta.pl/below", price_per_sqm: 8_799 }),
    row({ id: "above", external_listing_id: "above", original_url: "https://domiporta.pl/above", normalized_url: "https://domiporta.pl/above", price_per_sqm: 8_800 }),
  ]);
  const payload = await getRadarResults(OWNER, { ...baseFilters, minPricePerSqm: 8_800 }, currentDb as never);
  assert.deepEqual(payload.listings.map((listing) => listing.id), ["above"]);
  assert.equal(payload.stats[0]?.sampleSize, 1, "the stat count and card list use the same price-filtered unique set");
});

test("secondary turnkey records are assigned to category B while fresh secondary and turnkey primary records remain category A", async () => {
  currentDb = fakeDb([
    row({ id: "fresh-secondary" }),
    row({ id: "ready-secondary", external_listing_id: "ready", original_url: "https://domy.pl/ready", normalized_url: "https://domy.pl/ready", renovation_status: "turnkey_finish" }),
    row({ id: "turnkey-primary", source: "morizon", external_listing_id: "primary", original_url: "https://morizon.pl/primary", normalized_url: "https://morizon.pl/primary", market_type: "primary", renovation_status: "turnkey_finish" }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.deepEqual(payload.listings.map(({ id, qualityCategory }) => [id, qualityCategory]), [
    ["fresh-secondary", "fresh_renovation"],
    ["ready-secondary", "ready_high_standard"],
    ["turnkey-primary", "fresh_renovation"],
  ]);
  assert.equal(payload.stats.length, 3, "district, market, and quality category are independent groups");
});

test("an unmapped/invalid row (missing a required confirmed field) is silently excluded from the read, never crashing the page", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-bad", external_listing_id: "ext-bad", district: null })]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 1);
});

test("only an explicit adapter cross-source unit reference can merge portal copies, and the surviving card retains links to both", async () => {
  currentDb = fakeDb([
    row({ id: "listing-a", source: "domiporta", external_listing_id: "a", cross_source_identity: "portal_shared_unit_id:registry-123" }),
    row({ id: "listing-b", source: "olx", external_listing_id: "b", original_url: "https://olx.pl/b", normalized_url: "https://olx.pl/b", price: 455_000, area: 50.5, price_per_sqm: 9_010, cross_source_identity: "portal_shared_unit_id:registry-123" }),
  ]);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.listings[0].crossSourceAlternates.length, 1);
  assert.equal(payload.listings[0].crossSourceAlternates[0].originalUrl, "https://olx.pl/b");
  assert.equal(payload.listings[0].crossSourceAlternates[0].price, 455000);
  assert.equal(payload.stats[0].sampleSize, 1, "the identity group contributes one row to the radar sample");
});

test("a selected portal retains a confirmed group when its representative is from another portal", async () => {
  currentDb = fakeDb([
    row({ id: "listing-a", source: "domiporta", external_listing_id: "a", cross_source_identity: "canonical_unit_id:unit-portal-filter" }),
    row({ id: "listing-b", source: "olx", external_listing_id: "b", original_url: "https://olx.pl/b", normalized_url: "https://olx.pl/b", cross_source_identity: "canonical_unit_id:unit-portal-filter" }),
  ]);
  const payload = await getRadarResults(OWNER, { ...baseFilters, sources: ["olx"] }, currentDb as never);
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.listings[0].source, "domiporta", "the group keeps one deterministic representative");
  assert.equal(payload.listings[0].crossSourceAlternates[0]?.source, "olx");
  assert.equal(payload.stats[0].sampleSize, 1);
});

test("read path always scopes its database query to the authenticated owner", async () => {
  const rows = [row({ id: "owner-1-listing", owner_id: OWNER }), row({ id: "owner-2-listing", owner_id: "owner-2" })];
  currentDb = fakeDb(rows);
  const payload = await getRadarResults(OWNER, baseFilters, currentDb as never);
  assert.deepEqual(payload.listings.map((listing) => listing.id), ["owner-1-listing"]);
});
