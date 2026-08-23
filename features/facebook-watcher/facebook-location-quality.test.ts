import assert from "node:assert/strict";
import test from "node:test";
import { reconcileFacebookLocation, safeFacebookDisplayLocation } from "./facebook-location-quality.ts";
import type { FacebookProperty } from "./types.ts";

const base = {
  title: "Mieszkanie na sprzedaż przy ulicy Marysińskiej w Łodzi",
  description: "Mieszkanie w Łodzi",
  city: "Warszawa",
  district: "Praga Południe",
  neighborhood: "Saska Kępa",
  street: "Marysińska",
  price: 300_000,
  area: 40,
  rooms: 2,
  floor: null,
  totalFloors: null,
  marketType: "secondary",
  sellerType: "private",
  condition: "ready",
  originalUrl: null,
  images: [],
  confidence: 1,
  fieldConfidence: { city: 1, district: 1, neighborhood: 1 },
  flags: [],
  listingIntent: "SELL_PROPERTY",
  intentConfidence: 1,
  intentSource: "DETERMINISTIC_SELL",
  imageAssessments: [],
} satisfies FacebookProperty;

test("authoritative Łódź wins over conflicting Warsaw Vision location", () => {
  const result = reconcileFacebookLocation(base, { authoritativeText: base.description, groupName: "Łódź sprzedaż" });
  assert.equal(result.property.city, "Łódź");
  assert.equal(result.property.district, null);
  assert.equal(result.property.neighborhood, null);
  assert.equal(result.provenance.conflictReason, "AUTHORITATIVE_CITY_CONFLICT");
});

test("display location removes a conflicting Warsaw district from a Łódź Facebook listing", () => {
  assert.deepEqual(safeFacebookDisplayLocation({ source: "facebook", title: base.title, description: base.description, address: "Marysińska, Saska Kępa, Praga Południe, Warszawa", district: base.district, city: base.city }), {
    address: "Marysińska",
    district: null,
    city: "Łódź",
  });
});

test("group city is only a weak fallback and does not overwrite a known city", () => {
  const result = reconcileFacebookLocation({ ...base, title: "Oferta", description: null, city: null, district: null, neighborhood: null }, { authoritativeText: null, groupName: "Łódź okazje" });
  assert.equal(result.property.city, "Łódź");
  assert.equal(result.property.fieldConfidence?.city, 0.45);
  const known = reconcileFacebookLocation({ ...base, title: "Oferta", description: null }, { authoritativeText: null, groupName: "Łódź okazje" });
  assert.equal(known.property.city, "Warszawa");
});
