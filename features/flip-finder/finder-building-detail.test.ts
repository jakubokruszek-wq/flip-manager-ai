import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { enrichFinderBuildingDetail, needsFinderBuildingDetail } from "./finder-building-detail.ts";

const url = "https://gratka.pl/nieruchomosci/mieszkanie/ob/123";
const listing: PropertySourceListing = {
  source: "gratka", externalListingId: "123", originalUrl: url, normalizedUrl: url,
  title: "Mieszkanie", description: "Do remontu", price: 345000, area: 74.81, pricePerSqm: 4612,
  rooms: 3, floor: "3", city: "Łódź", district: "Polesie", locationText: null,
  buildingType: null, thumbnailUrl: null, ownership: null, images: [], publishedAt: null,
  rawPayload: {}, contentHash: "before",
};
function page(id = "123") {
  const own = { idOnFrontend: id, url: `/nieruchomosci/mieszkanie/ob/${id}`, status: 200,
    dataLayer: JSON.stringify({ property: { is_archived: false } }),
    title: "Mieszkanie", description: "Do remontu", types: { primaryType: "FLAT" }, transaction: "SALE",
    buildingDetailedInformation: [{ label: "Typ budynku", value: "Kamienica" }, { label: "Rok budowy", value: 1930 }] };
  const pool: unknown[] = [];
  function encode(value: unknown): number {
    const index = pool.length;pool.push(null);
    pool[index] = Array.isArray(value) ? value.map(encode) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) : value;
    return index;
  }
  encode({ data: { propertyData: own, similarProperties: [{ yearBuilt: 2000, buildingType: "Blok" }] } });
  return `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(pool)}</script>`;
}
test("Finder gets numeric own year/type without requiring Radar renovation qualification", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => new Response(page()));
  try {
    const value = await enrichFinderBuildingDetail(listing, new AbortController().signal);
    assert.equal(value.yearBuilt, 1930);assert.equal(value.buildingType, "kamienica");
    assert.equal(value.description, listing.description);assert.equal(value.price, listing.price);
    assert.equal(needsFinderBuildingDetail(value, { yearBuiltMin: 1960, buildingTypes: ["blok"] }), false);
    assert.equal(fetch.mock.callCount(), 1);
  } finally { fetch.mock.restore(); }
});
test("wrong identities and unsafe redirects never add facts or fetch a second host", async () => {
  for (const response of [new Response(page("999")), new Response(null, { status: 302, headers: { location: "https://127.0.0.1/ob/123" } })]) {
    const fetch = mock.method(globalThis, "fetch", async () => response);
    try { assert.equal(await enrichFinderBuildingDetail(listing, new AbortController().signal), listing);assert.equal(fetch.mock.callCount(), 1); }
    finally { fetch.mock.restore(); }
  }
});
test("failed detail reads stay unknown and caller cancellation propagates", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("unavailable"); });
  try {
    assert.equal(await enrichFinderBuildingDetail(listing, new AbortController().signal), listing);
    const parent = new AbortController();parent.abort();
    await assert.rejects(enrichFinderBuildingDetail(listing, parent.signal), { name: "AbortError" });
  } finally { fetch.mock.restore(); }
});
