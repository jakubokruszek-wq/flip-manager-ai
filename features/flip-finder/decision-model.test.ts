import assert from "node:assert/strict";
import test from "node:test";
import { decisionBucket, lifecycleForLastSeen } from "./decision-model.ts";

test("missing building type is review, not accept", () => assert.equal(decisionBucket({ reasons: [], unknownFields: ["buildingType"] }), "REVIEW"));
test("missing price is review", () => assert.equal(decisionBucket({ reasons: [], unknownFields: ["price"] }), "REVIEW"));
test("hard location rejection remains rejected", () => assert.equal(decisionBucket({ reasons: ["city"], unknownFields: [] }), "REJECTED"));
test("complete decision is matched", () => assert.equal(decisionBucket({ reasons: [], unknownFields: [] }), "MATCHED"));
test("stale and archived thresholds are deterministic", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");
  assert.equal(lifecycleForLastSeen(new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(), now), "STALE");
  assert.equal(lifecycleForLastSeen(new Date(now - 14 * 24 * 60 * 60 * 1_000).toISOString(), now), "ARCHIVED");
});
