import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[]) {
  return {
    from(table: string) {
      assert.equal(table, "price_radar_listings");
      const builder: Row = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: async () => ({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

let currentDb: ReturnType<typeof fakeDb>;
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
const { getRadarResults } = await import("./radar-results.ts");

function row(overrides: Row = {}): Row {
  return {
    id: "listing-1", source: "domiporta", external_listing_id: "ext-1", original_url: "https://domiporta.pl/1", normalized_url: "https://domiporta.pl/1",
    title: "Mieszkanie", description: null, price: 450_000, area: 50, price_per_sqm: 9_000, rooms: 2, city: "Łódź", district: "Bałuty",
    building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "hash-1",
    first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-05T00:00:00Z", status: "active", excluded_at: null, excluded_reason: null,
    ...overrides,
  };
}

const baseFilters = { districts: [], market: "both" as const, areaMin: null, areaMax: null, rooms: [], sources: [] };

test("reads active listings, computes stats, and returns them visible", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-2", external_listing_id: "ext-2", original_url: "https://domiporta.pl/2", normalized_url: "https://domiporta.pl/2", price: 500_000, price_per_sqm: 10_000 })]);
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 2);
  assert.equal(payload.excludedListings.length, 0);
  assert.equal(payload.stats.length, 1);
  assert.equal(payload.stats[0].averagePricePerSqm, 9_500);
  assert.equal(payload.stats[0].sampleSize, 2);
});

test("an excluded listing is reported separately and never counted in stats", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-2", external_listing_id: "ext-2", original_url: "https://domiporta.pl/2", normalized_url: "https://domiporta.pl/2", excluded_at: "2026-10-02T00:00:00Z", excluded_reason: "duplikat" })]);
  const payload = await getRadarResults(baseFilters);
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
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 1, "two rows sharing the same confirmed normalized_url for the same source must render as one listing");
});

test("cross-portal duplicate: identical price, area, district AND rooms across two different sources collapses to the earliest-discovered one", async () => {
  currentDb = fakeDb([
    row({ id: "listing-domiporta", source: "domiporta", external_listing_id: "d-1", first_seen_at: "2026-10-01T00:00:00Z" }),
    row({ id: "listing-olx", source: "olx", external_listing_id: "o-1", first_seen_at: "2026-10-03T00:00:00Z" }),
  ]);
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 1, "identical price+area+district+rooms across two portals must be treated as a confirmed duplicate");
  assert.equal(payload.listings[0].id, "listing-domiporta", "the earliest-discovered listing wins");
});

test("cross-portal listings that merely share a similar title or address but differ in price/area/rooms are NEVER merged", async () => {
  currentDb = fakeDb([
    row({ id: "listing-domiporta", source: "domiporta", external_listing_id: "d-2", title: "Ładne mieszkanie w Bałutach", price: 450_000 }),
    row({ id: "listing-olx", source: "olx", external_listing_id: "o-2", title: "Ładne mieszkanie w Bałutach", price: 455_000 }),
  ]);
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 2, "a different confirmed price must keep these as two distinct listings, regardless of the similar title");
});

test("two genuinely different apartments from the same portal sharing identical price/area/district/rooms are NOT collapsed -- cross-portal collapsing only applies across different sources", async () => {
  currentDb = fakeDb([
    row({ id: "listing-1", source: "domiporta", external_listing_id: "d-3", original_url: "https://domiporta.pl/d-3", normalized_url: "https://domiporta.pl/d-3" }),
    row({ id: "listing-2", source: "domiporta", external_listing_id: "d-4", original_url: "https://domiporta.pl/d-4", normalized_url: "https://domiporta.pl/d-4" }),
  ]);
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 2);
});

test("market=secondary/primary narrows results without mixing the stats groups", async () => {
  currentDb = fakeDb([
    row({ id: "listing-1" }),
    row({ id: "listing-2", external_listing_id: "ext-2", market_type: "primary", renovation_status: "turnkey_finish", price_per_sqm: 14_000 }),
  ]);
  const payload = await getRadarResults({ ...baseFilters, market: "secondary" });
  assert.equal(payload.listings.length, 1);
  assert.equal(payload.listings[0].marketType, "secondary");
});

test("an unmapped/invalid row (missing a required confirmed field) is silently excluded from the read, never crashing the page", async () => {
  currentDb = fakeDb([row(), row({ id: "listing-bad", external_listing_id: "ext-bad", district: null })]);
  const payload = await getRadarResults(baseFilters);
  assert.equal(payload.listings.length, 1);
});
