import assert from "node:assert/strict";
import test from "node:test";

import type { SearchFilter } from "@/features/flip-finder";
import { SOURCES } from "./search-source-registry.ts";

const filter: SearchFilter = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Otodom source count",
  sources: ["otodom"],
  city: "Łódź",
  districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null,
  rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false,
  buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false,
  maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60,
  isActive: true, lastScannedAt: null, createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
};

test("Otodom source preserves raw rows for 26-to-zero diagnostics", async () => {
  const previousFetch = globalThis.fetch;
  const items = Array.from({ length: 26 }, (_, index) => ({
    id: `bad-${index}`,
    url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz",
  }));
  const body = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { searchAds: { items } } } } })}</script>`;
  globalThis.fetch = async () => ({
    status: 200,
    url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz",
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => body,
  } as Response);
  try {
    const result = await SOURCES.find((source) => source.id === "otodom")!.fetch(filter);
    assert.equal(result.fetched, 26);
    assert.equal(result.listings.length, 0);
    assert.deepEqual(result.warnings, ["Otodom: search_or_category_url (26)"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
