import assert from "node:assert/strict";
import test from "node:test";
import { parseRadarOfferDetail } from "./external-source-adapters.ts";

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
