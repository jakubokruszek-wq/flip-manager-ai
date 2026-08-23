import assert from "node:assert/strict";
import test from "node:test";
import { classifyAvailabilityResponse, transitionListingLifecycle } from "./availability.ts";

const active = { status: "active" as const, missCount: 0, removedAt: null };

test("exact 404 and platform removed marker remove listing", () => {
  assert.equal(classifyAvailabilityResponse({ source: "olx", status: 404 }), "explicit_removed");
  assert.equal(classifyAvailabilityResponse({ source: "facebook", status: 200, body: "This content isn't available" }), "explicit_removed");
  assert.equal(transitionListingLifecycle(active, "explicit_removed", "2026-08-23T00:00:00Z").status, "removed");
});

test("403, 429 and timeout-class failures never increase missing counter", () => {
  for (const status of [401, 403, 429, 500]) assert.equal(classifyAvailabilityResponse({ source: "olx", status }), "temporary_failure");
  assert.deepEqual(transitionListingLifecycle(active, "temporary_failure", "2026-08-23T00:00:00Z"), { ...active, result: "temporary_failure", statusChanged: false });
});

test("one ambiguous miss is suspected and threshold removes", () => {
  const one = transitionListingLifecycle(active, "ambiguous_missing", "2026-08-23T00:00:00Z");
  assert.equal(one.status, "active"); assert.equal(one.missCount, 1);
  const two = transitionListingLifecycle(one, "ambiguous_missing", "2026-08-24T00:00:00Z");
  assert.equal(two.status, "active");
  const three = transitionListingLifecycle(two, "ambiguous_missing", "2026-08-25T00:00:00Z");
  assert.equal(three.status, "removed"); assert.equal(three.missCount, 3);
});

test("available listing reactivates without losing history", () => {
  const result = transitionListingLifecycle({ status: "removed", missCount: 3, removedAt: "2026-08-20T00:00:00Z" }, "available", "2026-08-23T00:00:00Z");
  assert.deepEqual(result, { status: "active", missCount: 0, removedAt: null, result: "available", statusChanged: true });
});
