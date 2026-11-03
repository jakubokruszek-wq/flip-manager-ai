import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchRadarMorizonDetails, parseRadarOfferDetail } from "./external-source-adapters.ts";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { qualifyRadarCandidate } from "@/features/price-radar/qualification";

// Same reference-pool/propertyData structure as public detail responses from
// Gratka and Morizon. Recommendations intentionally contain better facts.
function page(patch: Record<string, unknown> = {}) {
  const own = {
    title: "Mieszkanie na sprzedaż", description: "Mieszkanie w bloku. Rynek wtórny. Świeżo po generalnym remoncie, gotowe do zamieszkania.",
    idOnFrontend: "123", url: "/nieruchomosci/mieszkanie/ob/123", status: 200,
    dataLayer: JSON.stringify({ property: { is_archived: false } }),
    types: { primaryType: "FLAT" }, transaction: "SALE", marketType: "Rynek wtórny",
    price: { amount: 500000, currency: "PLN" }, area: "50", numberOfRoomsCount: 2, floor: 2,
    location: { location: ["łódzkie", "Łódź", "Bałuty"], street: "Mokra" },
    buildingDetailedInformation: [{ label: "Typ budynku", value: "Blok" }], ...patch,
  };
  const pool: unknown[] = [];
  function encode(value: unknown): number {
    const index = pool.length; pool.push(null);
    pool[index] = Array.isArray(value) ? value.map(encode)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value;
    return index;
  }
  encode({ data: { propertyData: own, similarProperties: [{ description: "Świeżo po generalnym remoncie, gotowe do zamieszkania.", area: 50 }] } });
  return `<h1>Mieszkanie</h1><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(pool)}</script>`;
}
const url = "https://gratka.pl/nieruchomosci/mieszkanie/ob/123";

test("Gratka detail supplies complete own facts rather than the 300-character result excerpt", () => {
  const result = parseRadarOfferDetail("gratka", page(), url);
  assert.equal(result.verified, true);
  assert.equal(result.price, 500000);
  assert.equal(result.area, 50);
  assert.equal(result.city, "Łódź");
  assert.equal(result.marketType, "secondary");
});
test("Morizon uses the same detail contract and verifies its own stable identity", () => {
  const result = parseRadarOfferDetail("morizon", page({ idOnFrontend: "mzn123", url: "/oferta/mieszkanie-mzn123" }), "https://www.morizon.pl/oferta/mieszkanie-mzn123");
  assert.equal(result.verified, true);
});
test("archived, wrong-identity, rental and incomplete facts never become verified", () => {
  for (const patch of [
    { dataLayer: JSON.stringify({ property: { is_archived: true } }) },
    { idOnFrontend: "999", url: "/nieruchomosci/mieszkanie/ob/999" },
    { transaction: "RENT" }, { price: null }, { location: {} },
    { dataLayer: null }, { description: "Brak informacji o standardzie." },
  ]) assert.equal(parseRadarOfferDetail("gratka", page(patch), url).verified, false, JSON.stringify(patch));
});
test("recommendations cannot supply the missing renovation evidence", () => {
  const result = parseRadarOfferDetail("gratka", page({ description: "Mieszkanie do remontu." }), url);
  assert.equal(result.description, "Mieszkanie do remontu.");
  assert.ok(result.unconfirmedFields.includes("renovation_recency"));
});
test("malformed and cyclic source pools fail closed", () => {
  for (const content of ["not-json", '[{"propertyData":0}]']) {
    assert.equal(parseRadarOfferDetail("gratka", `<script id="__NUXT_DATA__">${content}</script>`, url).verified, false);
  }
});

test("Morizon canonical street redirects match the stable mzn number even with legacy full-slug external IDs", async () => {
  const originalUrl = "https://www.morizon.pl/oferta/sprzedaz-mieszkanie-lodz-50m2-mzn123";
  const base: PropertySourceListing = {
    source: "morizon", externalListingId: "sprzedaz-mieszkanie-lodz-50m2-mzn123", originalUrl, normalizedUrl: originalUrl,
    title: "Mieszkanie świeżo po generalnym remoncie", description: "Świeżo po generalnym remoncie, gotowe do zamieszkania.", price: 500000, area: 50, pricePerSqm: 10000,
    rooms: 2, floor: null, city: "Łódź", district: "Bałuty", locationText: null,
    buildingType: null, thumbnailUrl: null, ownership: null, images: [], publishedAt: null,
    rawPayload: { radarSearchScope: "apartment-sale", radarBacklogRescan: true }, contentHash: "short",
  };
  let wrongId = false;
  let oldRenovation = false;
  const fetched = mock.method(globalThis, "fetch", async () => {
    const response = new Response(page({ idOnFrontend: "mzn123", url: "/oferta/sprzedaz-mieszkanie-lodz-mokra-50m2-mzn123",
      ...(oldRenovation ? { description: "Mieszkanie po generalnym remoncie w 2016, gotowe do zamieszkania. Rynek wtórny." } : {}),
    }));
    Object.defineProperty(response, "url", { value: wrongId
      ? "https://www.morizon.pl/oferta/sprzedaz-mieszkanie-lodz-mokra-50m2-mzn999"
      : "https://www.morizon.pl/oferta/sprzedaz-mieszkanie-lodz-mokra-50m2-mzn123" });
    return response;
  });
  try {
    const batches = { purpose: "price_radar" as const, onBatch: async () => {} };
    const valid = await fetchRadarMorizonDetails([base], undefined, batches);
    assert.equal(valid.listings[0]?.rawPayload.detailVerified, true);
    assert.equal((valid.listings[0]?.rawPayload.detailResponse as Record<string, unknown>).identity, "same_listing_id");
    assert.equal(valid.listings[0]?.externalListingId, base.externalListingId, "canonicalization never changes the saved replay identity");
    wrongId = true;
    const wrong = await fetchRadarMorizonDetails([base], undefined, batches);
    assert.equal(wrong.listings[0]?.rawPayload.detailVerified, false, "a different mznID is still rejected");
    wrongId = false;
    oldRenovation = true;
    const updated = (await fetchRadarMorizonDetails([base], undefined, batches)).listings[0]!;
    assert.equal(updated.rawPayload.detailVerified, true);
    assert.ok(!`${updated.title} ${updated.description}`.includes("Świeżo"), "historical freshness claims never leak into the new full detail");
    const qualification = qualifyRadarCandidate({ ...updated, source: "morizon", propertyType: "apartment", marketType: "secondary" });
    assert.deepEqual(qualification, { qualified: false, reason: "renovation_not_confirmed_fresh_full" });
  } finally { fetched.mock.restore(); }
});
