import assert from "node:assert/strict";
import test from "node:test";

import { estimateRenovation, RENOVATION_RATES } from "./estimate-renovation.ts";
import type { RenovationCostTier } from "./types.ts";

const AREAS = [30, 45, 50, 70, 100];
const TIERS: RenovationCostTier[] = ["economy", "standard", "premium"];

for (const area of AREAS) {
  for (const tier of TIERS) {
    test(`${tier}: ${area} m² respektuje twarde stawki i sumę kategorii`, () => {
      const estimate = estimateRenovation({
        tier,
        area,
        renovationLevel: "general",
        style: "luxury",
        budget: 60_000,
        options: ["floors", "doors", "kitchen", "bathroom", "lighting", "furniture", "carpentry"],
        propertyContext: { rooms: 3, buildingType: "blok" },
        visualizationConfidence: 10,
      });
      const rates = RENOVATION_RATES[tier];

      assert.equal(estimate.totalMin, area * rates.min);
      assert.equal(estimate.totalMax, area * rates.max);
      assert.equal(estimate.totalMax / area, rates.max);
      assert.ok(estimate.totalMax / area <= rates.max);
      assert.equal(estimate.categories.reduce((sum, category) => sum + category.min, 0), estimate.totalMin);
      assert.equal(estimate.categories.reduce((sum, category) => sum + category.max, 0), estimate.totalMax);
    });
  }
}

test("budżet użytkownika nie zmienia kosztorysu", () => {
  const low = estimateRenovation({ tier: "standard", area: 50, renovationLevel: "standard", style: "flip-budget", budget: 20_000, options: [], propertyContext: {} });
  const high = estimateRenovation({ tier: "standard", area: 50, renovationLevel: "standard", style: "luxury", budget: 150_000, options: [], propertyContext: {} });
  assert.equal(low.totalMin, 95_000);
  assert.equal(low.totalMax, 110_000);
  assert.equal(high.totalMin, low.totalMin);
  assert.equal(high.totalMax, low.totalMax);
});
