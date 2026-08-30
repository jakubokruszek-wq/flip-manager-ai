import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_READINESS_ATTEMPTS, COLLECTOR_READINESS_RETRY_DELAY_MS, latestScanCounters, retryCollectorReadiness, summarizeStartTrace } from "./dashboard.ts";

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

test("start trace ignores START_FAILED summary and identifies the first real broken hop", () => {
  const noBridge = summarizeStartTrace([
    { stage: "BUTTON_CLICKED", status: "PASS" },
    { stage: "READY_REQUEST_SENT", status: "PASS" },
    { stage: "START_FAILED", status: "FAIL", errorCode: "COLLECTOR_START_FAILED" },
  ]);
  assert.equal(noBridge.lastSuccessful, "READY_REQUEST_SENT");
  assert.equal(noBridge.firstFailed, null);
  assert.equal(noBridge.firstMissing, "BRIDGE_RECEIVED_READY");

  const pairing = summarizeStartTrace([
    { stage: "BUTTON_CLICKED", status: "PASS" },
    { stage: "READY_REQUEST_SENT", status: "PASS" },
    { stage: "BRIDGE_RECEIVED_READY", status: "PASS" },
    { stage: "EXTENSION_RECEIVED_READY", status: "PASS" },
    { stage: "EXTENSION_READY_RESULT", status: "FAIL", errorCode: "PAIRING_MISSING" },
    { stage: "START_FAILED", status: "FAIL", errorCode: "COLLECTOR_START_FAILED" },
  ]);
  assert.equal(pairing.firstFailed, "EXTENSION_READY_RESULT");
  assert.equal(pairing.errorCode, "PAIRING_MISSING");
});

test("bridge ping timeout is classified separately from READY timeout", () => {
  assert.equal(summarizeStartTrace([
    { stage: "BUTTON_CLICKED", status: "PASS" },
    { stage: "BRIDGE_PING_SENT", status: "PASS" },
    { stage: "BRIDGE_PONG_RECEIVED", status: "TIMEOUT", errorCode: "BRIDGE_NOT_INJECTED_OR_INACTIVE" },
  ]).firstFailed, "BRIDGE_PONG_RECEIVED");
});
