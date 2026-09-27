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
    { ...base, id: "same-id", url: "https://m.otodom.pl/pl/oferta/mieszkanie-IDABC123?fbclid=tracking" },
    { ...base, id: "other-id", url: "https://www.otodom.pl/pl/oferta/inne-IDXYZ987" },
  ];
  globalThis.fetch = async () => responseFor(items);
  try {
    const result = await searchOtodom(filter);
    assert.equal(result.rawItems, 3);
    assert.equal(result.normalizedItems, 2);
    assert.equal(result.listings.length, 2);
    assert.equal(result.rejectionReasons.duplicate, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
