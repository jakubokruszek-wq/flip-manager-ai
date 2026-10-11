import assert from "node:assert/strict";
import test from "node:test";

import type { SearchFilter } from "@/features/flip-finder";
import { searchOtodom } from "./otodom-search-adapter.ts";

const filter: SearchFilter = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Otodom diagnostics",
  sources: ["otodom"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: null,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

function responseFor(items: Record<string, unknown>[]): Response {
  const body = `<html><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { searchAds: { items } } } } })}</script></html>`;
  return {
    status: 200,
    url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz",
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => body,
  } as Response;
}

test("26 raw Otodom rows return concrete diagnostics instead of a generic zero-normalized error", async () => {
  const originalFetch = globalThis.fetch;
  const invalid = Array.from({ length: 26 }, (_, index) => ({ id: `bad-${index}`, url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz" }));
  globalThis.fetch = async () => responseFor(invalid);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.rawItems, 26);
    assert.equal(result.normalizedItems, 0);
    assert.equal(result.listings.length, 0);
    assert.equal(result.rejectionReasons.search_or_category_url, 26);
    assert.deepEqual(result.warnings, ["Otodom: search_or_category_url (26)"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("valid duplicate Otodom rows collapse after URL normalization and valid rows remain", async () => {
  const originalFetch = globalThis.fetch;
  const base = {
    title: "Mieszkanie testowe",
    price: 439000,
    area: 50,
    city: "Łódź",
  };
  const items = [
    { ...base, id: "same-id", url: "https://www.otodom.pl/pl/oferta/mieszkanie-IDABC123/?utm_source=feed" },
    { ...base, id: "different-id", url: "https://m.otodom.pl/pl/oferta/mieszkanie-IDABC123?fbclid=tracking" },
    { ...base, id: "other-id", url: "https://www.otodom.pl/pl/oferta/inne-IDXYZ987.html" },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.rawItems, 3);
    assert.equal(result.normalizedItems, 2);
    assert.equal(result.listings.length, 2);
    assert.equal(result.rejectionReasons.duplicate, 1);
    assert.equal(result.listings[1]?.originalUrl, "https://otodom.pl/pl/oferta/inne-IDXYZ987");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("current Otodom rows with relative href and no url reach the normalized listing pipeline", async () => {
  const originalFetch = globalThis.fetch;
  const items = [{
    id: "otodom-row-1",
    slug: "mieszkanie-testowe-IDABC123",
    href: "/pl/oferta/mieszkanie-testowe-IDABC123.html?utm_source=search",
    title: "Mieszkanie testowe",
    totalPrice: 439000,
    areaInSquareMeters: 50,
  }];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.normalizedItems, 1);
    assert.equal(result.listings.length, 1);
    assert.equal(result.rejectionReasons.placeholder_url, undefined);
    assert.equal(result.listings[0]?.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-IDABC123");
    assert.equal(result.listings[0]?.normalizedUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-IDABC123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Radar retains a confirmed Otodom offer URL when list-card title, price, and area are absent so its own detail can confirm them", async () => {
  const originalFetch = globalThis.fetch;
  const item = { id: 67883390, slug: "mieszkanie-lodz-polesie-ID4ABCD", estate: "FLAT", href: "[lang]/ad/mieszkanie-lodz-polesie-ID4ABCD" };
  globalThis.fetch = async () => responseFor([item]);
  try {
    const finder = await searchOtodom(filter);
    assert.equal(finder.listings.length, 0, "ordinary Finder results continue to reject an incomplete card");
    assert.equal(finder.rejectionReasons.missing_title, 1);

    const radar = await searchOtodom(filter, undefined, { includeIncompleteDetailCandidates: true });
    assert.equal(radar.listings.length, 0, "Radar does not publish an incomplete listing as a visible Finder card at this stage");
    assert.equal(radar.detailCandidates?.length, 1, "a confirmed single-offer URL and stable suffix are enough to request its own details");
    assert.equal(radar.detailCandidates?.[0]?.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-lodz-polesie-ID4ABCD");
    assert.equal(radar.rejectionReasons.missing_title, undefined, "a field recoverable from detail is not prematurely reported as a final rejection");
  } finally { globalThis.fetch = originalFetch; }
});

test("the real otodom.pl search response shape (href-only, '[lang]/ad/<slug>', no url field) recovers a confirmed /pl/oferta/<slug> address from the portal's own stable slug, and still excludes a whole-investment row", async () => {
  // Live-reproduced against the real otodom.pl Łódź secondary-market search
  // response on 2026-10-11: every one of 21 raw searchAds items had no
  // usable 'url' field, only an 'href' of the literal, unsubstituted shape
  // "[lang]/ad/<slug>" or "[lang]/investment/<slug>" -- otodom.pl's own
  // i18n routing leaking a raw Next.js route segment into the page it
  // serves. An earlier version of this test concluded from exactly this
  // shape that the row was "genuinely broken, not a parser gap" -- that
  // was wrong: it had only compared id/title/href and never noticed the
  // row's own 'slug' and 'estate' fields (both present on every real row,
  // reproduced here), which this adapter now reads instead of trying to
  // repair the broken href. "/pl/oferta/<slug>" for the individual-unit row
  // below is confirmed live (200, no further redirect); the exact same
  // construction for the investment row live-redirects to
  // "/pl/inwestycja/<slug>" instead -- a development overview, not an
  // apartment -- which is why item.estate gates this fallback.
  const originalFetch = globalThis.fetch;
  const items = [
    { id: 67883390, title: "Mieszkanie 2 pokoje 46,55 m2, Łódź, ul. Grabieniec", slug: "mieszkanie-2-pokoje-46-55-m2-lodz-ul-grabieniec-ID4APzo", estate: "FLAT", href: "[lang]/ad/mieszkanie-2-pokoje-46-55-m2-lodz-ul-grabieniec-ID4APzo", totalPrice: 450000, areaInSquareMeters: 46.55 },
    { id: 68123474, title: "Diasfera Łódzka", slug: "diasfera-lodzka-ID4BQ1I", estate: "INVESTMENT", href: "[lang]/investment/diasfera-lodzka-ID4BQ1I", totalPrice: 399000, areaInSquareMeters: 38 },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.rawItems, 2);
    assert.equal(result.listings.length, 1, "the individual FLAT row recovers a confirmed offer URL from its own slug");
    assert.equal(result.listings[0]?.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-2-pokoje-46-55-m2-lodz-ul-grabieniec-ID4APzo");
    // item.id is numeric on the real response, so text() (string-only) falls
    // through to the id embedded in the now-confirmed URL itself -- the
    // same stable "-ID<code>" suffix extractOtodomListingId already reads
    // for every other Otodom row in this file.
    assert.equal(result.listings[0]?.externalListingId, "4APzo");
    assert.equal(result.rejectionReasons.placeholder_url, undefined, "a recoverable slug must never be reported as a broken/placeholder URL");
    assert.equal(result.rejectionReasons.unsupported_listing, 1, "the whole-investment row is excluded under its own distinct, honest reason");
    assert.deepEqual(result.warnings, ["Otodom: unsupported_listing (1)"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a FLAT row missing a slug, a malformed slug with no -ID<code> suffix, or an INVESTMENT row that happens to carry a slug, never receives a constructed offer URL", async () => {
  const originalFetch = globalThis.fetch;
  const items = [
    { id: "no-slug", title: "Brak slug", estate: "FLAT", href: "[lang]/ad/brak-slug-ID1", totalPrice: 400000, areaInSquareMeters: 40 },
    { id: "malformed-slug", title: "Zły slug", estate: "FLAT", slug: "brak-numeru-oferty", href: "[lang]/ad/brak-numeru-oferty", totalPrice: 400000, areaInSquareMeters: 40 },
    { id: "investment-with-slug", title: "Inwestycja", estate: "INVESTMENT", slug: "inwestycja-ID2", href: "[lang]/investment/inwestycja-ID2", totalPrice: 400000, areaInSquareMeters: 40 },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.listings.length, 0);
    assert.equal(result.rejectionReasons.unsupported_listing, 1, "only the confirmed investment row uses that reason");
    assert.ok((result.rejectionReasons.placeholder_url ?? 0) + (result.rejectionReasons.missing_offer_id ?? 0) >= 2, "the two FLAT rows with no recoverable slug stay genuinely unconfirmed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a placeholder or search href remains rejected while a valid sibling URL is accepted", async () => {
  const originalFetch = globalThis.fetch;
  const items = [
    { id: "placeholder", href: "/[lang]/oferta/mieszkanie-IDBAD123", title: "Placeholder", totalPrice: 439000, areaInSquareMeters: 50 },
    { id: "search", href: "/pl/wyniki/sprzedaz/mieszkanie/lodz", title: "Search", totalPrice: 439000, areaInSquareMeters: 50 },
    { id: "foreign-host", href: "https://evil.example/pl/oferta/mieszkanie-IDBAD999", title: "Foreign host", totalPrice: 439000, areaInSquareMeters: 50 },
    { id: "valid-sibling", url: "/[lang]/oferta/mieszkanie-IDBAD123", href: "/pl/oferta/mieszkanie-IDGOOD123", title: "Valid sibling", totalPrice: 439000, areaInSquareMeters: 50 },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0]?.externalListingId, "valid-sibling");
    assert.equal(result.rejectionReasons.placeholder_url, 1);
    assert.equal(result.rejectionReasons.search_or_category_url, 1);
    assert.equal(result.rejectionReasons.invalid_url, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
