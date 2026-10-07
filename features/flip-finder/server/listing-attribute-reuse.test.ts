import assert from "node:assert/strict";
import test from "node:test";
import type { SourceListing } from "./search-source-registry.ts";
import { reuseExistingListingAttributes } from "./listing-attribute-reuse.ts";

const sourceListing = (overrides: Record<string, unknown> = {}) => ({
  source: "domy",
  externalListingId: "domy-123",
  originalUrl: "https://domy.pl/mieszkanie/123",
  normalizedUrl: "https://domy.pl/mieszkanie/123",
  title: "Mieszkanie",
  price: 439000,
  area: 53,
  rooms: 2,
  floor: null,
  pricePerSqm: 8283,
  city: "Łódź",
  district: null,
  locationText: "Łódź",
  images: [],
  thumbnailUrl: null,
  buildingType: null,
  ownership: null,
  description: null,
  rawPayload: {},
  contentHash: "same-content",
  ...overrides,
}) as SourceListing;

function orderedRowsClient(rows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      assert.equal(table, "listings");
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
        in(column: string, value: unknown) { filters.push({ column, value }); return builder; },
        order(column: string, options: { ascending?: boolean }) {
          const matches = rows.filter((row) => filters.every(({ column: filterColumn, value }) => {
            const actual = row[filterColumn];
            return Array.isArray(value) ? value.includes(actual) : actual === value;
          }));
          matches.sort((left, right) => {
            const comparison = String(right[column] ?? "").localeCompare(String(left[column] ?? ""));
            return options.ascending ? -comparison : comparison;
          });
          return Promise.resolve({ data: matches, error: null });
        },
      };
      return builder;
    },
  };
}

test("attribute reuse prefers the newest stored confirmation and never overwrites fresh evidence", async () => {
  const db = orderedRowsClient([
    { source: "domy", external_listing_id: "domy-123", normalized_url: "https://domy.pl/mieszkanie/123", building_type: "kamienica", ownership: "udział", last_seen_at: "2026-10-01T10:00:00.000Z" },
    { source: "domy", external_listing_id: "domy-123", normalized_url: "https://domy.pl/mieszkanie/123", building_type: "blok", ownership: "pełna własność", last_seen_at: "2026-10-02T10:00:00.000Z" },
  ]);
  const [reused] = await reuseExistingListingAttributes(db as never, [sourceListing()]);
  assert.equal(reused?.buildingType, "blok");
  assert.equal(reused?.ownership, "pełna własność");

  const [freshWins] = await reuseExistingListingAttributes(db as never, [sourceListing({ buildingType: "dom" })]);
  assert.equal(freshWins?.buildingType, "dom", "a current confirmed attribute takes precedence over older stored evidence");
  assert.equal(freshWins?.ownership, "pełna własność", "a missing current field is filled from the latest stored confirmation");
});
