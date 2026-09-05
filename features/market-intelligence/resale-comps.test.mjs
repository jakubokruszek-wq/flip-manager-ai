import assert from "node:assert/strict";
import test from "node:test";

import { classifyRenovation, priceObservationChanged, resaleCompFingerprint } from "./resale-comps.ts";

test("generalny remont tworzy comp HIGH", () => {
  const result = classifyRenovation({ title: "Mieszkanie po generalnym remoncie", description: "Nowe instalacje i wykończenie pod klucz", price: 500000, areaM2: 50, pricePerM2: 10000 });
  assert.equal(result.isCandidate, true);
  assert.equal(result.renovationConfidence, "HIGH");
  assert.equal(result.renovationStatus, "MOVE_IN_READY");
});

test("odświeżone nie jest HIGH", () => {
  const result = classifyRenovation({ title: "Zadbane, odświeżone mieszkanie", description: null, price: 300000, areaM2: 50, pricePerM2: 6000 });
  assert.equal(result.isCandidate, true);
  assert.notEqual(result.renovationConfidence, "HIGH");
});

test("najem i dom nie stają się resale comp", () => {
  assert.equal(classifyRenovation({ title: "Mieszkanie po remoncie do wynajęcia", description: null, price: 3000, areaM2: 50, pricePerM2: 60 }).isCandidate, false);
  assert.equal(classifyRenovation({ title: "Dom po generalnym remoncie", description: null, price: 700000, areaM2: 100, pricePerM2: 7000 }).isCandidate, false);
});

test("błędna cena jest zachowana jako outlier", () => {
  const result = classifyRenovation({ title: "Po generalnym remoncie", description: null, price: 510, areaM2: 50, pricePerM2: 10.2 });
  assert.equal(result.isCandidate, true);
  assert.equal(result.outlierReason, "PRICE_PER_M2_OUTLIER");
});

test("fingerprint jest deterministyczny i wymaga kompletu pól", () => {
  assert.equal(resaleCompFingerprint({ address: "ul. Próba 1", areaM2: 50, price: 500000, rooms: 2 }), "ul. proba 1|50|500000|2");
  assert.equal(resaleCompFingerprint({ address: null, areaM2: 50, price: 500000, rooms: 2 }), null);
});

test("zmiana ceny wymaga nowej obserwacji, powtórka nie tworzy historii", () => {
  assert.equal(priceObservationChanged({ price: 500000, pricePerM2: 10000 }, 490000, 9800), true);
  assert.equal(priceObservationChanged({ price: 500000, pricePerM2: 10000 }, 500000, 10000), false);
});
