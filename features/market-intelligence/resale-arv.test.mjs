import assert from "node:assert/strict";
import test from "node:test";

import { calculateResaleArv, selectResaleComps } from "./resale-arv.ts";

const comp = (id, overrides = {}) => ({
  id,
  source: "otodom",
  externalListingId: id,
  canonicalUrl: `https://example.com/${id}`,
  title: "Po generalnym remoncie",
  description: "Nowe instalacje",
  city: "Łódź",
  district: "Bałuty",
  street: "Rojna",
  address: "Rojna 10",
  latitude: null,
  longitude: null,
  price: 500000,
  areaM2: 50,
  pricePerM2: 10000,
  rooms: 2,
  floor: "2",
  buildingType: "blok",
  lastSeenAt: "2026-09-01T00:00:00.000Z",
  active: true,
  fingerprint: null,
  classification: { isCandidate: true, renovationStatus: "RENOVATED", renovationConfidence: "HIGH", finishLevel: "GENERAL_RENOVATION", evidence: ["generalny remont"], outlierReason: null, exclusionReason: null },
  ...overrides,
});

test("wybiera świeże podobne comps i odrzuca kamienicę dla bloku", () => {
  const subject = { id: "subject", area: 50, rooms: 2, city: "Łódź", district: "Bałuty", address: "Rojna 2", buildingType: "blok" };
  const selected = selectResaleComps(subject, [comp("same"), comp("tenement", { buildingType: "kamienica" })], Date.parse("2026-09-02T00:00:00.000Z"));
  assert.deepEqual(selected.map((item) => item.id), ["same"]);
  assert.equal(selected[0].renovationConfidence, "HIGH");
});

test("LOW i outlier nie wpływają na ARV", () => {
  const subject = { id: "subject", area: 50, rooms: 2, city: "Łódź", district: "Bałuty", address: "Rojna 2", buildingType: "blok" };
  const selected = selectResaleComps(subject, [comp("high"), comp("low", { pricePerM2: 1000, classification: { ...comp("x").classification, renovationConfidence: "LOW" } })]);
  const arv = calculateResaleArv(subject, selected);
  assert.equal(arv.compCount, 1);
  assert.equal(arv.expectedPrice, 500000);
});

test("stary comp ma niższą wagę, ale nie znika bez śladu", () => {
  const subject = { id: "subject", area: 50, rooms: 2, city: "Łódź", district: "Bałuty", address: "Rojna 2", buildingType: "blok" };
  const selected = selectResaleComps(subject, [comp("fresh", { pricePerM2: 10000 }), comp("old", { pricePerM2: 14000, lastSeenAt: "2026-05-01T00:00:00.000Z" })], Date.parse("2026-09-02T00:00:00.000Z"));
  assert.equal(selected.length, 2);
  assert.ok((selected.find((item) => item.id === "old")?.freshnessDays ?? 0) > 90);
  const arv = calculateResaleArv(subject, selected);
  assert.ok(arv.expectedPrice !== null);
});
