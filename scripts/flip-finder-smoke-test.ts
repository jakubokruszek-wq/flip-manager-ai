import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canRunManualScan,
  dashboardCount,
  filterResultsHref,
  hasLatestScan,
  NO_SCANS_MESSAGE,
  scanStatusLabel,
} from "../features/flip-finder/dashboard";
import {
  buildSearchUrl,
  isPriceDrop,
  needsSnapshot,
} from "../features/flip-finder/otodom-search";
import type { SearchFilter } from "../features/flip-finder/types";
import {
  classifyOtodomFetchError,
  inspectOtodomSearchResponse,
} from "../features/flip-finder/otodom-search-response";
import {
  displayMetric,
  filterMatchesForFilter,
  isFilterMissing,
  isNewMatch,
  parseResultSort,
  resultLocation,
  resultStatus,
  sortResults,
} from "../features/flip-finder/results";
import { addScanItemCounts } from "../features/flip-finder/scan-counters";
import { evaluateFilter } from "../features/flip-finder/filter-evaluation";
import { planFilterMatchRecalculation } from "../features/flip-finder/filter-match-recalculation-plan";
import { resolveListingImages } from "../features/flip-finder/listing-images";
import {
  normalizeFacebookCollectorPayload,
  normalizeFacebookPostUrl,
} from "../features/collector/facebook-normalization";
import { filterResultsByText } from "../features/flip-finder/results";

const completedScan = {
  startedAt: "2026-07-19T10:00:00Z",
  finishedAt: "2026-07-19T10:05:00Z",
};

const searchFilterForUrlTests: SearchFilter = {
  id: "url-test",
  name: "Test URL",
  sources: ["otodom"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: 600000,
  areaMin: 35,
  areaMax: 70,
  rooms: [2, 3],
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
  createdAt: "2026-07-19T10:00:00Z",
  updatedAt: "2026-07-19T10:00:00Z",
};

assert.ok(
  buildSearchUrl(searchFilterForUrlTests).startsWith(
    "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodzkie/lodz/lodz/lodz",
  ),
);
assert.ok(
  buildSearchUrl({ ...searchFilterForUrlTests, city: "Warszawa" }).startsWith(
    "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/mazowieckie/warszawa/warszawa/warszawa",
  ),
);
assert.ok(
  buildSearchUrl({ ...searchFilterForUrlTests, city: "Kraków" }).startsWith(
    "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/malopolskie/krakow/krakow/krakow",
  ),
);
assert.ok(
  buildSearchUrl({ ...searchFilterForUrlTests, city: "Miasto nieobsługiwane" }).startsWith(
    "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/cala-polska",
  ),
);

assert.equal(parseResultSort("bad"), "newest");

const rows = [
  {
    isNew: false,
    isActive: true,
    lastSeenAt: "2026-07-19T09:00:00Z",
    lastMatchedAt: "2026-07-19T09:00:00Z",
    price: 30,
    pricePerSqm: 3,
    priceDropAmount: 1,
  },
  {
    isNew: true,
    isActive: false,
    lastSeenAt: "2026-07-19T11:00:00Z",
    lastMatchedAt: "2026-07-19T11:00:00Z",
    price: 20,
    pricePerSqm: 2,
    priceDropAmount: 5,
  },
  {
    isNew: false,
    isActive: true,
    lastSeenAt: "2026-07-19T12:00:00Z",
    lastMatchedAt: "2026-07-19T12:00:00Z",
    price: null,
    pricePerSqm: null,
    priceDropAmount: null,
  },
];

assert.equal(sortResults(rows, "newest")[0].price, null);
assert.equal(sortResults(rows, "price_asc")[0].price, 20);
assert.equal(sortResults(rows, "price_per_sqm_asc")[0].price, 20);
assert.equal(sortResults(rows, "price_per_sqm_asc").at(-1)?.pricePerSqm, null);
assert.equal(sortResults(rows, "biggest_price_drop")[0].price, 20);

assert.equal(isNewMatch("2026-07-19T10:03:00Z", completedScan), true);
assert.equal(isNewMatch("2026-07-19T09:59:59Z", completedScan), false);
assert.equal(isNewMatch("2026-07-19T10:03:00Z", null), false);
assert.equal(isNewMatch("2026-07-18T10:03:00Z", completedScan), false);
assert.equal(
  resultStatus(
    { firstMatchedAt: "2026-07-19T10:03:00Z", previousPrice: 100, currentPrice: 90 },
    completedScan,
  ).priceDropAmount,
  10,
);
assert.equal(
  resultStatus(
    { firstMatchedAt: "2026-07-19T10:03:00Z", previousPrice: 90, currentPrice: 100 },
    completedScan,
  ).hasPriceDrop,
  false,
);
assert.equal(
  resultStatus(
    { firstMatchedAt: "2026-07-19T10:03:00Z", previousPrice: null, currentPrice: 90 },
    completedScan,
  ).priceDropAmount,
  null,
);

assert.equal(isPriceDrop(100, 90), true);
assert.equal(needsSnapshot({ price: 100, contentHash: "a" }, { price: 100, contentHash: "a" }), false);
assert.equal(needsSnapshot({ price: 100, contentHash: "a" }, { price: 90, contentHash: "a" }), true);

let counters = { listingsCreatedCount: 0, newMatchesCount: 0 };
counters = addScanItemCounts(counters, { listingCreated: true, matchCreated: true });
assert.deepEqual(counters, { listingsCreatedCount: 1, newMatchesCount: 1 });
counters = addScanItemCounts(counters, { listingCreated: false, matchCreated: true });
assert.deepEqual(counters, { listingsCreatedCount: 1, newMatchesCount: 2 });
counters = addScanItemCounts(counters, { listingCreated: false, matchCreated: false });
assert.deepEqual(counters, { listingsCreatedCount: 1, newMatchesCount: 2 });
counters = addScanItemCounts(counters, { listingCreated: false, matchCreated: true });
assert.deepEqual(counters, { listingsCreatedCount: 1, newMatchesCount: 3 });

assert.equal(dashboardCount(0), 0);
assert.equal(dashboardCount(undefined), 0);
assert.equal(canRunManualScan(false, false), false);
assert.equal(canRunManualScan(true, true), false);
assert.equal(canRunManualScan(true, false), true);
assert.equal(filterResultsHref("filter-123"), "/flip-finder/filters/filter-123/results");
assert.equal(hasLatestScan(null), false);
assert.equal(NO_SCANS_MESSAGE, "Nie uruchomiono jeszcze żadnego skanu ofert.");
assert.equal(scanStatusLabel("completed"), "Zakończony");
assert.equal(scanStatusLabel("partial"), "Częściowo zakończony");

const matches = [
  { searchFilterId: "filter-a", listingId: "listing-a" },
  { searchFilterId: "filter-b", listingId: "listing-b" },
];
assert.deepEqual(filterMatchesForFilter(matches, "filter-a"), [matches[0]]);
assert.deepEqual(filterMatchesForFilter(matches, "filter-b"), [matches[1]]);
assert.deepEqual(filterMatchesForFilter(matches, "missing-filter"), []);
assert.equal(isFilterMissing(null), true);
assert.equal(isFilterMissing({ id: "filter-a" }), false);
assert.equal(resultLocation(null, null, null), null);
assert.equal(resultLocation("ul. Testowa 1", null, "Warszawa"), "ul. Testowa 1, Warszawa");
assert.equal(displayMetric(null, "m²"), null);
assert.equal(displayMetric(0, "m²"), null);
assert.equal(displayMetric(45, "m²"), "45 m²");
assert.equal("https://www.otodom.pl/pl/oferta/123", "https://www.otodom.pl/pl/oferta/123");

const otodomSample = readFileSync(
  new URL("../features/flip-finder/__fixtures__/otodom-search-results.sample.html", import.meta.url),
  "utf8",
);

assert.equal(
  inspectOtodomSearchResponse({
    status: 403,
    contentType: "text/html",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: "blocked",
  }),
  "forbidden",
);
assert.equal(
  inspectOtodomSearchResponse({
    status: 429,
    contentType: "text/html",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: "slow down",
  }),
  "rate_limited",
);
assert.equal(classifyOtodomFetchError({ name: "TimeoutError" }), "timeout");
assert.equal(
  inspectOtodomSearchResponse({
    status: 200,
    contentType: "text/html",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: "<html><title>Just a moment...</title>__cf_chl_</html>",
  }),
  "challenge",
);
assert.equal(
  inspectOtodomSearchResponse({ status: 200, contentType: "text/html", finalUrl: "https://www.otodom.pl", body: '<html><title>Wyniki</title><script>const text = "challenge captcha";</script><script id="__NEXT_DATA__">{}</script></html>' }),
  null,
);
assert.equal(
  inspectOtodomSearchResponse({ status: 200, contentType: "text/html", finalUrl: "https://www.otodom.pl", body: '<html><title>Just a moment...</title></html>' }),
  "challenge",
);
assert.equal(
  inspectOtodomSearchResponse({ status: 200, contentType: "text/html", finalUrl: "https://www.otodom.pl", body: '<html>__cf_chl_ DataDome captcha</html>' }),
  "challenge",
);
assert.equal(
  inspectOtodomSearchResponse({
    status: 200,
    contentType: "text/html",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: "",
  }),
  "empty_response",
);
assert.equal(
  inspectOtodomSearchResponse({
    status: 200,
    contentType: "text/html; charset=utf-8",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: otodomSample,
  }),
  null,
);
assert.equal(
  inspectOtodomSearchResponse({
    status: 200,
    contentType: "application/json",
    finalUrl: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie",
    body: "{}",
  }),
  "changed_structure",
);
assert.equal(
  classifyOtodomFetchError({ cause: { code: "ECONNRESET" } }),
  "connection",
);

assert.ok(buildSearchUrl(searchFilterForUrlTests).includes("roomsNumber=%5BTWO%2CTHREE%5D"));
assert.equal(evaluateFilter({ price: 385000, area: 38, pricePerSqm: null, rooms: 2, floor: "1", city: "Łódź", district: null, title: "Oferta", locationText: null, buildingType: null }, { ...searchFilterForUrlTests, maxPricePerSqm: 7000 }).matches, false);
assert.equal(evaluateFilter({ price: 279000, area: 38.8, pricePerSqm: null, rooms: 2, floor: "1", city: "Łódź", district: null, title: "Oferta", locationText: null, buildingType: null }, { ...searchFilterForUrlTests, maxPricePerSqm: 7000 }).matches, false);

const pricePerSqmFilter = { ...searchFilterForUrlTests, maxPricePerSqm: 7000 };
const strictPriceCandidate = {
  price: 385000,
  area: 38,
  pricePerSqm: null,
  rooms: 2,
  floor: "1",
  city: "Łódź",
  district: null,
  title: "Oferta",
  locationText: null,
  buildingType: null,
};
assert.equal(evaluateFilter(strictPriceCandidate, pricePerSqmFilter).matches, false);
assert.equal(
  evaluateFilter({ ...strictPriceCandidate, price: 320000, area: 42.42 }, pricePerSqmFilter)
    .matches,
  false,
);
assert.equal(
  evaluateFilter({ ...strictPriceCandidate, price: 279000, area: 38.8 }, pricePerSqmFilter)
    .matches,
  false,
);
assert.equal(
  evaluateFilter({ ...strictPriceCandidate, price: 280000, area: 40 }, pricePerSqmFilter)
    .matches,
  true,
);
assert.equal(
  evaluateFilter({ ...strictPriceCandidate, price: null }, pricePerSqmFilter).matches,
  false,
);
assert.equal(
  evaluateFilter({ ...strictPriceCandidate, area: null }, pricePerSqmFilter).matches,
  false,
);
const unknownBuildingDecision = evaluateFilter(
  { ...strictPriceCandidate, price: 280000, area: 40 },
  { ...pricePerSqmFilter, buildingTypes: ["blok"] },
);
assert.equal(unknownBuildingDecision.matches, true);
assert.deepEqual(unknownBuildingDecision.unknownFields, ["buildingType"]);
assert.equal(
  evaluateFilter(
    { ...strictPriceCandidate, price: 280000, area: 40, buildingType: "kamienica" },
    { ...pricePerSqmFilter, buildingTypes: ["blok"] },
  ).matches,
  false,
);

const facebookCollectorPayload = normalizeFacebookCollectorPayload({
  sourcePostUrl: "https://www.facebook.com/groups/test/posts/123/?utm_source=share",
  groupName: "Mieszkania Łódź",
  authorName: "Jan Kowalski",
  publishedAt: "2026-07-19T12:00:00Z",
  content: "Mieszkanie 40 m2",
  price: 280000,
  area: 40,
  rooms: 2,
  location: "Łódź",
  imageUrls: ["https://cdn.example.test/a.jpg", "https://cdn.example.test/a.jpg", "invalid-url"],
  collectedAt: "2026-07-19T12:01:00Z",
});
assert.equal(
  facebookCollectorPayload.normalizedPostUrl,
  "https://www.facebook.com/groups/test/posts/123",
);
assert.equal(facebookCollectorPayload.imageUrls.length, 1);
assert.equal(facebookCollectorPayload.pricePerSqm, 7000);
assert.equal(facebookCollectorPayload.externalListingId.startsWith("facebook:"), true);
assert.equal(
  normalizeFacebookPostUrl("https://m.facebook.com/groups/test/posts/123/?ref=share"),
  "https://m.facebook.com/groups/test/posts/123",
);
assert.throws(() => normalizeFacebookPostUrl("http://facebook.com/groups/test/posts/123"));

const resultForEverySource = (source: "otodom" | "olx" | "morizon" | "facebook") => ({
  id: `${source}-listing`,
  title: `${source} oferta przy Testowej`,
  price: 280000,
  area: 40,
  rooms: 2,
  floor: "3",
  totalFloors: null,
  buildingType: null,
  ownership: null,
  description: "Opis oferta",
  images: [],
  pricePerSqm: 7000,
  locationText: "Łódź",
  address: "Testowa 1",
  city: "Łódź",
  district: "Śródmieście",
  thumbnailUrl: null,
  originalUrl: `https://example.test/${source}`,
  source,
  listingStatus: "active" as const,
  isActive: true,
  firstSeenAt: "2026-07-19T10:00:00Z",
  lastSeenAt: "2026-07-19T10:00:00Z",
  firstMatchedAt: "2026-07-19T10:00:00Z",
  lastMatchedAt: "2026-07-19T10:00:00Z",
  previousPrice: null,
  currentPrice: 280000,
  isNew: true,
  hasPriceDrop: false,
  priceDropAmount: null,
  matchReasons: ["scan"],
  unknownFields: [],
});
const crossSourceResults = ["otodom", "olx", "morizon", "facebook"].map((source) =>
  resultForEverySource(source as "otodom" | "olx" | "morizon" | "facebook"),
);
assert.equal(filterResultsByText(crossSourceResults, "otodom").length, 1);
assert.equal(filterResultsByText(crossSourceResults, "testowa").length, 4);
assert.equal(filterResultsByText(crossSourceResults, "nieistniejąca").length, 0);
assert.deepEqual(resolveListingImages([], "https://images.example.test/olx.jpg"), ["https://images.example.test/olx.jpg"]);
assert.deepEqual(resolveListingImages([], null), []);
assert.deepEqual(resolveListingImages(["https://images.example.test/existing.jpg"], null), ["https://images.example.test/existing.jpg"]);

const recalculationListing = {
  id: "olx-7544",
  source: "olx" as const,
  originalUrl: "https://www.olx.pl/d/oferta/test-ID7544.html",
  ...strictPriceCandidate,
  price: 320000,
  area: 42.42,
};
const recalculationBaseFilter = {
  ...pricePerSqmFilter,
  sources: ["olx"] as SearchFilter["sources"],
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
};
const strictRecalculation = planFilterMatchRecalculation(
  recalculationBaseFilter,
  [recalculationListing],
  [{ listingId: recalculationListing.id }],
);
assert.deepEqual(strictRecalculation.removedListingIds, [recalculationListing.id]);
assert.equal(strictRecalculation.maxPricePerSqmAfter, null);
const relaxedRecalculation = planFilterMatchRecalculation(
  { ...recalculationBaseFilter, maxPricePerSqm: 8000 },
  [recalculationListing],
  [],
);
assert.deepEqual(relaxedRecalculation.addedListingIds, [recalculationListing.id]);
assert.equal(relaxedRecalculation.maxPricePerSqmAfter, 320000 / 42.42);
const exactLimitListing = { ...recalculationListing, id: "otodom-7000", source: "otodom" as const, price: 280000, area: 40 };
const sourceChange = planFilterMatchRecalculation(
  { ...recalculationBaseFilter, sources: ["otodom"] },
  [recalculationListing, exactLimitListing],
  [{ listingId: recalculationListing.id }],
);
assert.deepEqual(sourceChange.removedListingIds, [recalculationListing.id]);
assert.deepEqual(sourceChange.addedListingIds, [exactLimitListing.id]);
const idempotentRecalculation = planFilterMatchRecalculation(
  { ...recalculationBaseFilter, sources: ["otodom"], maxPricePerSqm: 7000 },
  [exactLimitListing],
  [{ listingId: exactLimitListing.id }],
);
assert.equal(idempotentRecalculation.addedListingIds.length, 0);
assert.equal(idempotentRecalculation.removedListingIds.length, 0);
const morizonCategory = {
  ...exactLimitListing,
  id: "morizon-category",
  source: "morizon" as const,
  title: "Mieszkania na sprzedaż Łódź",
  originalUrl: "https://www.morizon.pl/mieszkania/lodz/",
  price: null,
  area: null,
};
assert.deepEqual(
  planFilterMatchRecalculation(
    { ...recalculationBaseFilter, sources: ["morizon"] },
    [morizonCategory],
    [{ listingId: morizonCategory.id }],
  ).removedListingIds,
  [morizonCategory.id],
);

async function runOtodomAdapterContractTest(): Promise<void> {
const otodomContractItems = Array.from({ length: 24 }, (_, index) => ({
  id: String(900_000 + index),
  url: `/pl/oferta/oferta-testowa-ID${900_000 + index}`,
  title: `Oferta testowa ${index + 1}`,
  totalPrice: { value: 300_000 + index },
  areaInSquareMeters: 50,
  roomsNumber: "TWO",
  floorNumber: "FLOOR_1",
  location: { city: "Lodz" },
  images: [{ url: "https://images.example.test/thumbnail.jpg" }],
}));
const otodomRejectedItems = Array.from({ length: 5 }, () => ({
  slug: "bez-identyfikatora",
}));
const otodomContractFixture = `<html><head><title>Wyniki</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      data: {
        searchAds: {
          items: [...otodomContractItems, ...otodomRejectedItems],
        },
      },
    },
  },
})}</script></body></html>`;

type ResolveFilename = (
  request: string,
  parent?: unknown,
  isMain?: boolean,
  options?: unknown,
) => string;
type ModuleInternals = { _resolveFilename: ResolveFilename };

const serverOnlyStub = join(tmpdir(), `flip-manager-server-only-${process.pid}.cjs`);
const moduleInternals = Module as unknown as ModuleInternals;
const originalResolveFilename = moduleInternals._resolveFilename;
const originalFetch = globalThis.fetch;

writeFileSync(serverOnlyStub, "module.exports = {};\n", "utf8");
moduleInternals._resolveFilename = (request, parent, isMain, options) =>
  request === "server-only"
    ? serverOnlyStub
    : originalResolveFilename(request, parent, isMain, options);

try {
  globalThis.fetch = async () => {
    const response = new Response(otodomContractFixture, {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    });
    Object.defineProperty(response, "url", {
      value: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodzkie/lodz/lodz/lodz",
    });
    return response;
  };

  const [{ SOURCES, isOtodomAdapterContractMismatch }, { sourceScanMetrics }] =
    await Promise.all([
      import("../features/flip-finder/server/search-source-registry"),
      import("../features/flip-finder/server/manual-scan"),
    ]);
  const otodomSource = SOURCES.find((source) => source.id === "otodom");

  assert.ok(otodomSource);
  const sourceResult = await otodomSource.fetch(searchFilterForUrlTests);
  const matchedCount = sourceResult.listings.filter((listing, index) =>
    evaluateFilter(
      { ...listing, price: index < 3 ? listing.price : 700_000 },
      searchFilterForUrlTests,
    ).matches,
  ).length;
  const metrics = sourceScanMetrics(sourceResult, matchedCount);

  assert.equal(sourceResult.fetched, 24);
  assert.equal(sourceResult.listings.length, 24);
  assert.equal(metrics.scannedCount, 24);
  assert.equal(metrics.listingsFound, 24);
  assert.equal(metrics.matchedCount, 3);
  assert.equal(
    isOtodomAdapterContractMismatch({
      rawItems: 29,
      normalizedItems: 24,
      listings: [],
    }),
    true,
  );
} finally {
  globalThis.fetch = originalFetch;
  moduleInternals._resolveFilename = originalResolveFilename;
  unlinkSync(serverOnlyStub);
}
}

void runOtodomAdapterContractTest()
  .then(() => {
    console.log("flip-finder smoke tests: 66 passed");
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
