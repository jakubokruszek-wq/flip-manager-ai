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

test("the real otodom.pl search response shape (href-only, '[lang]/ad/<slug>-ID<code>', no url field) is rejected as a genuinely broken source record, not a parser gap", async () => {
  // Live-reproduced against the real otodom.pl Łódź secondary-market search
  // response on 2026-10-09: 26 of 27 raw searchAds items had no 'url' field
  // at all, only an 'href' of the literal, unsubstituted shape
  // "[lang]/ad/<slug>-ID<code>" or "[lang]/investment/<slug>-ID<code>" --
  // otodom.pl's own i18n routing leaking a raw Next.js route segment into the
  // page it serves, not something this codebase builds or can fix. This is
  // the exact field shape observed (trimmed to what the adapter reads), to
  // prove the rejection survives against real-world data, not just a
  // hand-shaped /oferta/ fixture.
  const originalFetch = globalThis.fetch;
  const items = [
    { id: 67883390, title: "Mieszkanie 2 pokoje 46,55 m2, Łódź, ul. Grabieniec", href: "[lang]/ad/mieszkanie-2-pokoje-46-55-m2-lodz-ul-grabieniec-ID4APzo", totalPrice: 450000, areaInSquareMeters: 46.55 },
    { id: 68123474, title: "Diasfera Łódzka", href: "[lang]/investment/diasfera-lodzka-ID4BQ1I", totalPrice: 399000, areaInSquareMeters: 38 },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.rawItems, 2);
    assert.equal(result.listings.length, 0, "no [lang]-broken item may ever become a usable listing link");
    assert.equal(result.rejectionReasons.placeholder_url, 2);
    assert.deepEqual(result.warnings, ["Otodom: placeholder_url (2)"]);
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
