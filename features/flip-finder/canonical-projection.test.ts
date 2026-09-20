import assert from "node:assert/strict";
import test from "node:test";
import { canonicalProjection } from "./canonical-projection.ts";

test("canonical projection keeps matched, review, and rejected lifecycle/membership state aligned", () => {
  const matched = canonicalProjection({ bucket: "MATCHED", reasons: ["price"], missingFields: [], hardRejectReasons: [] });
  assert.deepEqual(matched, { bucket: "MATCHED", lifecycleStatus: "ACTIVE", isCurrentMatch: true, matchReasons: ["price"], missingFields: [] });

  const review = canonicalProjection({ bucket: "REVIEW", reasons: ["weak_location"], missingFields: ["price", "area"], hardRejectReasons: [] });
  assert.equal(review.lifecycleStatus, "REVIEW");
  assert.equal(review.isCurrentMatch, false);
  assert.deepEqual(review.matchReasons, ["review", "weak_location", "unknown_price", "unknown_area"]);
  assert.deepEqual(review.missingFields, ["price", "area"]);

  const rejected = canonicalProjection({ bucket: "REJECTED", reasons: ["price_too_high"], missingFields: [], hardRejectReasons: ["price_too_high"] });
  assert.deepEqual(rejected, { bucket: "REJECTED", lifecycleStatus: "REJECTED", isCurrentMatch: false, matchReasons: ["price_too_high"], missingFields: [] });
});

test("explicit lifecycle is limited to operational states", () => {
  const review = canonicalProjection({ bucket: "REVIEW", reasons: [], missingFields: ["floor"], hardRejectReasons: [] }, "REVIEW");
  assert.equal(review.lifecycleStatus, "REVIEW");
});
