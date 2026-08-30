import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_READINESS_ATTEMPTS, COLLECTOR_READINESS_RETRY_DELAY_MS, latestScanCounters, retryCollectorReadiness } from "./dashboard.ts";

test("maps persisted scan update and price-drop counters to the UI", () => {
  assert.deepEqual(
    latestScanCounters({ listingsUpdated: 1, priceDropCount: 1 }),
    { updatedCount: 1, priceDropCount: 1 },
  );
});

test("collector readiness retry budget is bounded", () => {
  assert.equal(COLLECTOR_READINESS_ATTEMPTS, 3);
  assert.ok(COLLECTOR_READINESS_RETRY_DELAY_MS > 0);
  assert.ok(COLLECTOR_READINESS_ATTEMPTS * 5_000 + (COLLECTOR_READINESS_ATTEMPTS - 1) * COLLECTOR_READINESS_RETRY_DELAY_MS < 20_000);
});

test("collector readiness retries until first ACK and stops at three attempts", async () => {
  for (const ackAttempt of [1, 2, 3]) {
    let calls = 0;
    const result = await retryCollectorReadiness(async () => ({ ok: ++calls === ackAttempt }), () => {}, async () => {});
    assert.equal(result.ok, true);
    assert.equal(calls, ackAttempt);
  }
  let calls = 0;
  const failed = await retryCollectorReadiness(async () => ({ ok: ++calls > 3 }), () => {}, async () => {});
  assert.equal(failed.ok, false);
  assert.equal(calls, 3);
});
