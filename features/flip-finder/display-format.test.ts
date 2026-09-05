import assert from "node:assert/strict";
import test from "node:test";

import { cleanDisplayText, dedupeLocationText, friendlyMissingFields } from "./display-format.ts";

test("deduplicates repeated location fragments", () => {
  assert.equal(dedupeLocationText("Łódź, Łódź, Chojny, Łódź"), "Łódź, Chojny");
  assert.equal(dedupeLocationText("ul. Ogniskowa 8, Łódź, Chojny"), "ul. Ogniskowa 8, Łódź, Chojny");
});

test("cleans display markdown and emoji without changing source data", () => {
  assert.equal(cleanDisplayText("  **2 POKOJE | 38 m²** 🏠\n  oferta  "), "2 POKOJE | 38 m²\noferta");
});

test("uses friendly labels for technical fields", () => {
  assert.deepEqual(friendlyMissingFields(["buildingType", "topFloor", "ownership", "buildingType"]), ["typ budynku", "liczba pięter w budynku", "forma własności"]);
});
