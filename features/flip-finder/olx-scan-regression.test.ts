/**
 * Regression for the first OLX scan run by the Cloudflare stage-2 Worker
 * (GitHub Actions run 38460045910): 52 ads read, 49 unique ids (3 promoted
 * repeats), 1 current match, kamienice and a 19 m² studio rejected.
 * Parser -> batch dedupe -> filter decision, on the real Finder parser.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { evaluateListingAgainstFilter } from "./filter-evaluation.ts";
import type { SearchFilter } from "./index.ts";
import { dedupeListingsByExternalId, emptyListingScanStats, formatListingScanStats, olxUrlIdToken, recordListingOutcome } from "./olx-batch.ts";
import { parseOlxHtml } from "./olx-parser.ts";

const filter = {
  id: "lodz-flip", name: "Łódź flip", sources: ["olx"], city: "Łódź", districts: [],
  priceMin: null, priceMax: 300_000, areaMin: 25, areaMax: null, rooms: [2, 3], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok"], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: null, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
} satisfies SearchFilter;

type Ad = Record<string, unknown>;

function ad(options: { id: number; token: string; slug: string; title: string; price: number; area: number; rooms: string; built: string; district?: string; description?: string }): Ad {
  return {
    id: options.id,
    title: options.title,
    description: options.description ?? `<p>${options.title}. Łódź, ${options.district ?? "Bałuty"}.</p>`,
    url: `https://www.olx.pl/d/oferta/${options.slug}-CID3-ID${options.token}.html`,
    params: [
      { key: "price", value: `${options.price} zł`, normalizedValue: String(options.price) },
      { key: "m", value: `${options.area} m²`, normalizedValue: String(options.area) },
      { key: "rooms", value: options.rooms, normalizedValue: options.rooms },
      { key: "floor_select", value: "2", normalizedValue: "floor_2" },
      { key: "market", value: "Wtórny", normalizedValue: "secondary" },
      { key: "builttype", value: options.built, normalizedValue: options.built },
    ],
    price: { regularPrice: { value: options.price, currencyCode: "PLN" } },
    location: { cityName: "Łódź", districtName: options.district ?? "Bałuty" },
    photos: [],
    createdTime: "2026-10-12T10:00:00+02:00",
  };
}

function page(ads: Ad[]): string {
  const state = JSON.stringify({ listing: { listing: { ads } } });
  return `<html><body><script>window.__PRERENDERED_STATE__ = ${JSON.stringify(state)};</script></body></html>`;
}

const TEOFILOW = ad({ id: 1_000_001, token: "TEOF1", slug: "najciekawsze-mieszkanie-na-teofilowie", title: "Najciekawsze Mieszkanie NA Teofilowie", price: 238_000, area: 37.07, rooms: "two", built: "blok" });
const KAMIENICA = ad({ id: 1_000_002, token: "KAM1", slug: "mieszkanie-w-kamienicy-srodmiescie", title: "Mieszkanie w kamienicy, Śródmieście", price: 260_000, area: 48, rooms: "two", built: "kamienica", district: "Śródmieście" });
const KAWALERKA = ad({ id: 1_000_003, token: "KAW1", slug: "kawalerka-19-m2-widzew", title: "Kawalerka 19 m², Widzew", price: 159_000, area: 19, rooms: "one", built: "blok", district: "Widzew" });

function listingOf(source: Ad) {
  const parsed = parseOlxHtml(page([source]));
  assert.equal(parsed.listings.length, 1);
  return parsed.listings[0];
}

test("the Teofilów flat (37.07 m², 2 rooms, blok, 238 000 zł) is a current match", () => {
  const listing = listingOf(TEOFILOW);
  assert.equal(listing.area, 37.07);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.price, 238_000);
  assert.equal(listing.buildingType, "blok");
  const decision = evaluateListingAgainstFilter(listing, filter);
  assert.equal(decision.matches, true);
  assert.equal(decision.bucket, "MATCHED");
});

test("a kamienica is rejected by a blok-only filter, not sent to review", () => {
  const listing = listingOf(KAMIENICA);
  assert.equal(listing.buildingType, "kamienica");
  const decision = evaluateListingAgainstFilter(listing, filter);
  assert.equal(decision.matches, false);
  assert.equal(decision.bucket, "REJECTED");
  assert.ok(decision.reasons.some((reason) => /building|tenement|kamienic/i.test(reason)), decision.reasons.join(","));
});

test("a 19 m² studio is rejected by area (and rooms), not sent to review", () => {
  const decision = evaluateListingAgainstFilter(listingOf(KAWALERKA), filter);
  assert.equal(decision.matches, false);
  assert.equal(decision.bucket, "REJECTED");
  assert.ok(decision.reasons.includes("area_min"), decision.reasons.join(","));
  assert.ok(decision.reasons.includes("rooms"), decision.reasons.join(","));
});

test("52 ads with 3 promoted repeats: 49 unique offers, each evaluated once; stats keep source data apart from the filter outcome", () => {
  const others = Array.from({ length: 46 }, (_, index) => ad({ id: 2_000_000 + index, token: `OTH${index}`, slug: `mieszkanie-${index}`, title: `Mieszkanie ${index}`, price: 400_000 + index, area: 50, rooms: "three", built: "blok" }));
  // OLX shows promoted ads above the list and again in it: the same ad object twice.
  const ads = [TEOFILOW, KAMIENICA, KAWALERKA, TEOFILOW, KAMIENICA, KAWALERKA, ...others];
  assert.equal(ads.length, 52);
  const parsed = parseOlxHtml(page(ads));
  assert.equal(parsed.listings.length, 52);
  const batch = dedupeListingsByExternalId(parsed.listings);
  assert.equal(batch.listings.length, 49);
  assert.equal(batch.duplicates, 3);
  assert.equal(batch.conflictingDuplicates, 0, "identical repeats are not a conflict");
  assert.equal(new Set(batch.listings.map((listing) => listing.externalListingId)).size, 49);

  const stats = { ...emptyListingScanStats(), read: 52, duplicates: batch.duplicates };
  for (const listing of batch.listings) {
    const decision = evaluateListingAgainstFilter(listing, filter);
    recordListingOutcome(stats, { bucket: decision.bucket === "MATCHED" && decision.matches ? "MATCHED" : decision.bucket === "REVIEW" ? "REVIEW" : "REJECTED", created: false, updated: false });
  }
  assert.equal(stats.unique, 49);
  assert.equal(stats.matched, 1, "the repeated Teofilów ad counts as one match");
  assert.equal(stats.matched + stats.review + stats.rejectedByFilter, stats.unique);
  assert.match(formatListingScanStats(stats), /Odczytane 52, unikalne 49, powtórzenia 3/);
});

test("a repeat with a different price is reported as a conflict and the first page copy is kept", () => {
  const listing = listingOf(TEOFILOW);
  const batch = dedupeListingsByExternalId([listing, { ...listing, price: 230_000, contentHash: "other" }]);
  assert.equal(batch.listings.length, 1);
  assert.equal(batch.listings[0].price, 238_000);
  assert.equal(batch.conflictingDuplicates, 1);
});

test("legacy OLX id is the URL slug, so a title edit changes it; the -ID token does not", () => {
  const before = listingOf(TEOFILOW);
  const after = listingOf({ ...TEOFILOW, title: "Teofilów, 2 pokoje, po remoncie", url: "https://www.olx.pl/d/oferta/teofilow-2-pokoje-po-remoncie-CID3-IDTEOF1.html" });
  assert.notEqual(before.externalListingId, after.externalListingId, "the parser's id follows the slug");
  assert.notEqual(before.normalizedUrl, after.normalizedUrl);
  assert.equal(olxUrlIdToken(before.normalizedUrl), "TEOF1");
  assert.equal(olxUrlIdToken(after.normalizedUrl), "TEOF1");
});

test("olxUrlIdToken accepts only OLX offer URLs ending in -ID<token>.html", () => {
  assert.equal(olxUrlIdToken("https://olx.pl/d/oferta/mieszkanie-CID3-IDAbc9.html"), "Abc9");
  assert.equal(olxUrlIdToken("https://www.olx.pl/d/oferta/mieszkanie-CID3-IDAbc9.html?reason=x"), "Abc9");
  assert.equal(olxUrlIdToken("https://www.otodom.pl/pl/oferta/mieszkanie-ID4abc.html"), null);
  assert.equal(olxUrlIdToken("https://olx.pl/d/oferta/mieszkanie-bez-tokenu"), null);
  assert.equal(olxUrlIdToken("https://olx.pl/d/oferta/x-ID%25_.html"), null, "LIKE wildcards can never come from the token");
  assert.equal(olxUrlIdToken(null), null);
});
