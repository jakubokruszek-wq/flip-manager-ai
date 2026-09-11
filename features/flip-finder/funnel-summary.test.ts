import assert from "node:assert/strict";
import test from "node:test";
import { summarizeHardRejects } from "./funnel-summary.ts";

test("overlapping hard reasons count once per post but each reason separately", () => {
  const result = summarizeHardRejects([
    { postId: "1", decision: "REJECTED", decisionReasons: ["max_price_per_sqm", "area_max"] },
    { postId: "2", decision: "REVIEW", decisionReasons: ["building_type_missing"] },
  ]);
  assert.equal(result.unique, 1);
  assert.equal(result.reasons.pricePerSqmAboveMax, 1);
  assert.equal(result.reasons.areaAboveMax, 1);
  assert.equal(result.reasons.excludedBuildingType, undefined);
});

test("review and missing fields never become hard rejects", () => {
  const result = summarizeHardRejects([{ postId: "1", decision: "REVIEW", decisionReasons: ["price_missing", "building_type_missing"] }]);
  assert.deepEqual(result, { unique: 0, reasons: {} });
});
