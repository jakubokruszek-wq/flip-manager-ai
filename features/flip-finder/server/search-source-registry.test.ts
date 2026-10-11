import assert from "node:assert/strict";
import test from "node:test";

import type { SearchFilter } from "@/features/flip-finder";
import { activeSources, EXTERNAL_SOURCE_CONFIGS, EXTERNAL_SOURCE_STATUS, SOURCES, slugifyCity } from "./search-source-registry.ts";

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
    ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "bezposrednio", "domy", "allegro_lokalnie", "official_cooperative", "official_uml", "official_auction"],
  );
});

test("source paths use the stable Łódź slug", () => {
  assert.equal(slugifyCity("Łódź"), "lodz");
  assert.equal(slugifyCity("Łódź-Bałuty"), "lodz-baluty");
});

test("only complete schema-ready adapters are schedulable; legacy Szybko IDs have no runtime entry", () => {
  assert.deepEqual(
    activeSources({
      ...filter,
      sources: ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "szybko", "domy", "allegro_lokalnie", "gratka", "nieruchomosci_online"],
    }).map((source) => source.id),
    ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "domy", "allegro_lokalnie"],
  );
  assert.deepEqual(activeSources({ ...filter, sources: ["bezposrednio", "official_cooperative", "official_uml", "official_auction"] }).map((source) => source.id), ["official_cooperative", "official_uml"]);
});

// Szybko remains a recognized historical ListingSource, but its old saved
// source ID has no parser/config/worker registration and cannot be scheduled.
test("Szybko is absent from every runtime source registry while other verified sources remain active", () => {
  assert.equal(EXTERNAL_SOURCE_STATUS.oferty_net, "public_html_adapter");
  assert.equal(Object.hasOwn(EXTERNAL_SOURCE_STATUS, "szybko"), false);
  assert.equal(EXTERNAL_SOURCE_STATUS.domy, "public_html_adapter");
  assert.equal(EXTERNAL_SOURCE_STATUS.allegro_lokalnie, "public_html_adapter");
  assert.equal(EXTERNAL_SOURCE_CONFIGS.some((source) => (source.id as string) === "szybko"), false);
  assert.equal(SOURCES.some((source) => (source.id as string) === "szybko"), false);
  assert.deepEqual(activeSources({ ...filter, sources: ["oferty_net", "szybko", "domy", "allegro_lokalnie"] }).map((source) => source.id), ["oferty_net", "domy", "allegro_lokalnie"]);
});

test("Radar Otodom dispatch enriches an incomplete result row from that same confirmed detail URL", async () => {
  const originalFetch = globalThis.fetch;
  const url = "https://otodom.pl/pl/oferta/mieszkanie-lodz-gorna-dabrowa-ID4ABCD";
  const item = { id: 67883390, slug: "mieszkanie-lodz-gorna-dabrowa-ID4ABCD", estate: "FLAT", href: "[lang]/ad/mieszkanie-lodz-gorna-dabrowa-ID4ABCD" };
  const searchHtml = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { searchAds: { items: [item] } } } } })}</script>`;
  const detailHtml = `<title>Mieszkanie na sprzedaż, Łódź Górna</title><h1>Mieszkanie na sprzedaż, Łódź, Górna, Dąbrowa</h1><script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: {
    ad: { status: "active", title: "Mieszkanie na sprzedaż Łódź Górna", adCategory: { name: "FLAT", type: "SELL" }, attributes: { building_type: "block", market: "secondary", m: 41, rooms_num: 2, floor_no: "floor_1" }, location: { address: { city: { name: "Łódź" }, district: { name: "Górna" }, subdistrict: { name: "Dąbrowa" }, street: { name: "Przykładowa" } } } },
    unifiedAd: { description: "Mieszkanie jest w pełni wykończone pod klucz, w wysokim standardzie i gotowe do zamieszkania.", price: { salePrice: { value: 425000 } } },
  } } } )}</script>`;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const requested = String(input); requests.push(requested);
    const body = requested.includes("/pl/oferta/") ? detailHtml : searchHtml;
    return { status: 200, ok: true, url: requested, headers: new Headers({ "content-type": "text/html" }), text: async () => body } as Response;
  };
  try {
    const batches = { purpose: "price_radar" as const, deadlineAt: Date.now() + 50_000, onBatch: async () => undefined };
    const result = await SOURCES.find((source) => source.id === "otodom")!.fetch(filter, undefined, batches);
    assert.equal(requests.length, 2, "the existing search fetch is followed by exactly one detail request");
    assert.ok(requests[1]?.startsWith(url));
    assert.equal(result.fetched, 1);
    assert.equal(result.listings.length, 1);
    const listing = result.listings[0]!;
    assert.equal(listing.externalListingId, "4ABCD");
    assert.equal(listing.price, 425_000);
    assert.equal(listing.area, 41);
    assert.equal(listing.rooms, 2);
    assert.equal(listing.city, "Łódź");
    assert.equal(listing.district, "Górna");
    assert.equal(listing.buildingType, "blok");
    assert.equal(listing.rawPayload.marketType, "secondary");
    assert.equal(listing.rawPayload.detailVerified, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("a legacy filter cannot schedule unavailable or disabled sources while preserving active source IDs", () => {
  assert.deepEqual(
    activeSources({
      ...filter,
      sources: [
        "otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "domy", "allegro_lokalnie", "gratka", "nieruchomosci_online",
        "facebook", "oferty_net", "szybko", "bezposrednio",
        "official_cooperative", "official_uml", "official_auction",
      ],
    }).map((source) => source.id),
    ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "domy", "allegro_lokalnie", "official_cooperative", "official_uml"],
  );
});

test("external adapters retry a rate-limited response once and parse only the verified listing", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const body = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", url: "https://gratka.pl/nieruchomosci/mieszkania/lodz", name: "Mieszkania na sprzedaż Łódź", offers: { "@type": "AggregateOffer", offers: [{ "@type": "Offer", url: "https://gratka.pl/nieruchomosci/mieszkanie-lodz-1/ob/12345", name: "Mieszkanie Łódź", price: "489000.00", itemOffered: { floorSize: { value: 53 }, address: { addressLocality: "Bałuty" } } }] } })}</script>`;
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
