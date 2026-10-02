import assert from "node:assert/strict";
import test from "node:test";

import type { SearchFilter } from "@/features/flip-finder";
import { activeSources, EXTERNAL_SOURCE_STATUS, SOURCES, slugifyCity } from "./search-source-registry.ts";

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

test("registry exposes every requested external adapter without touching the network", () => {
  assert.deepEqual(
    SOURCES.map((source) => source.id),
    ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "szybko", "bezposrednio", "domy", "allegro_lokalnie", "official_cooperative", "official_uml", "official_auction"],
  );
});

test("source paths use the stable Łódź slug", () => {
  assert.equal(slugifyCity("Łódź"), "lodz");
  assert.equal(slugifyCity("Łódź-Bałuty"), "lodz-baluty");
});

test("only complete schema-ready adapters are schedulable", () => {
  assert.deepEqual(
    activeSources({
      ...filter,
      sources: ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "szybko", "domy", "allegro_lokalnie"],
    }).map((source) => source.id),
    ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "domy", "allegro_lokalnie"],
  );
  assert.deepEqual(activeSources({ ...filter, sources: ["gratka", "nieruchomosci_online", "oferty_net", "bezposrednio", "official_cooperative", "official_uml", "official_auction"] }).map((source) => source.id), []);
});

test("Szybko remains registered but is disabled pending live access verification", () => {
  assert.equal(EXTERNAL_SOURCE_STATUS.szybko, "path_requires_live_source_verification");
  assert.deepEqual(activeSources({ ...filter, sources: ["szybko"] }).map((source) => source.id), []);
});

test("a legacy filter cannot schedule unavailable sources while preserving active source IDs", () => {
  assert.deepEqual(
    activeSources({
      ...filter,
      sources: [
        "otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "domy", "allegro_lokalnie",
        "facebook", "gratka", "nieruchomosci_online", "oferty_net", "szybko", "bezposrednio",
        "official_cooperative", "official_uml", "official_auction",
      ],
    }).map((source) => source.id),
    ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "domy", "allegro_lokalnie"],
  );
});

test("external adapters retry a rate-limited response once and parse only the verified listing", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const body = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "g-1", url: "https://gratka.pl/oferta/lodz-1", name: "Mieszkanie Łódź", offers: { price: 489000 }, itemOffered: { floorSize: { value: 53 }, address: { addressLocality: "Łódź" } } })}</script>`;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await SOURCES.find((source) => source.id === "gratka")!.fetch(filter);
    assert.equal(calls, 2);
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0]?.price, 489000);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
