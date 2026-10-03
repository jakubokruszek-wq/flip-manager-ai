import assert from "node:assert/strict";
import test from "node:test";

import { toListingRow } from "./filter-results.ts";
import { LISTING_SOURCES } from "@/features/flip-finder/types/index.ts";

/**
 * Real, proven contributor to the "0 aktywnych ofert" half of the stuck-scan
 * report: toListingRow() had its OWN hand-maintained isListingSource
 * allowlist, independent of the shared, exhaustively-checked LISTING_SOURCES
 * list, and it had drifted to recognize only 7 of the 17 real registered
 * sources. Every active listing whose source was one of the other 10
 * (gratka, nieruchomosci_online, domiporta, sprzedajemy, adresowo,
 * oferty_net, szybko, bezposrednio, domy, allegro_lokalnie -- Allegro
 * Lokalnie being the exact source named in the report's own screenshot) was
 * silently dropped here, never reaching the Finder results a filter
 * displays, regardless of how many real matches the database held or
 * whether the scan that created them ever finished.
 */
function listingRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "listing-1",
    original_url: "https://allegrolokalnie.pl/oferta/mieszkanie-1",
    source: "allegro_lokalnie",
    status: "active",
    first_seen_at: "2026-10-01T10:00:00.000Z",
    last_seen_at: "2026-10-01T10:00:00.000Z",
    title: "Mieszkanie",
    price: 300_000,
    area: 45,
    images: [],
    missing_fields: [],
    ...overrides,
  };
}

test("every currently registered listing source is accepted by toListingRow -- none are silently dropped from Finder results", () => {
  for (const source of LISTING_SOURCES) {
    const listing = toListingRow(listingRow({ source }));
    assert.ok(listing, `a real active listing from "${source}" must reach Finder's results, not be silently dropped`);
    assert.equal(listing?.source, source);
  }
});

test("the exact regression: a real Allegro Lokalnie listing (the source named in the stuck-scan report) is no longer dropped", () => {
  const listing = toListingRow(listingRow({ source: "allegro_lokalnie" }));
  assert.ok(listing, "an Allegro Lokalnie listing must appear in Finder results");
  assert.equal(listing?.id, "listing-1");
  assert.equal(listing?.source, "allegro_lokalnie");
});

test("an unknown/invalid source is still correctly rejected, proving this is an allowlist fix, not a bypass of validation", () => {
  const listing = toListingRow(listingRow({ source: "not-a-real-source" }));
  assert.equal(listing, null);
});
