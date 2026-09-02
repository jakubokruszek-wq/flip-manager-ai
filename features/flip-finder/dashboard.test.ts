import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_BOOTSTRAP_MAX_WAIT_MS, COLLECTOR_BOOTSTRAP_POLL_INTERVAL_MS, COLLECTOR_READINESS_ATTEMPTS, COLLECTOR_READINESS_RETRY_DELAY_MS, latestScanCounters, retryCollectorReadiness, summarizeStartTrace, waitForCollectorBootstrap } from "./dashboard.ts";

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

async function bootstrapScenario({ markerAt = null, pongAt = null, stale = false }: { markerAt?: number | null; pongAt?: number | null; stale?: boolean }) {
  let elapsedMs = 0;
  const pingTimes: number[] = [];
  const result = await waitForCollectorBootstrap({
    readMarker: () => stale ? "stale" : markerAt !== null && elapsedMs >= markerAt ? "runtime-generation" : null,
    ping: () => { pingTimes.push(elapsedMs); return pongAt !== null && elapsedMs >= pongAt; },
    now: () => elapsedMs,
    sleep: async (ms) => { elapsedMs += ms; },
  });
  return { result, elapsedMs, pingTimes };
}

test("bootstrap accepts markers delayed by 100, 700 and 1500 ms", async () => {
  for (const markerAt of [100, 700, 1_500]) {
    const scenario = await bootstrapScenario({ markerAt });
    assert.deepEqual(scenario.result, { ok: true, source: "marker" });
    assert.ok(scenario.elapsedMs >= markerAt);
    assert.ok(scenario.elapsedMs <= markerAt + COLLECTOR_BOOTSTRAP_POLL_INTERVAL_MS * 2);
  }
});

test("bootstrap accepts an exact PONG before the DOM marker", async () => {
  const scenario = await bootstrapScenario({ markerAt: 1_500, pongAt: 250 });
  assert.deepEqual(scenario.result, { ok: true, source: "pong" });
  assert.equal(scenario.elapsedMs, 250);
});

test("bootstrap briefly retries PING after a marker appears", async () => {
  const scenario = await bootstrapScenario({ markerAt: 700 });
  assert.deepEqual(scenario.result, { ok: true, source: "marker" });
  assert.ok(scenario.pingTimes.filter((time) => time >= 700).length >= 2);
});

test("stale or absent bootstrap times out only after the full budget", async () => {
  for (const scenario of [await bootstrapScenario({ stale: true }), await bootstrapScenario({})]) {
    assert.deepEqual(scenario.result, { ok: false, source: null, error: "BOOTSTRAP_START_TIMEOUT" });
    assert.equal(scenario.elapsedMs, COLLECTOR_BOOTSTRAP_MAX_WAIT_MS);
  }
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

test("start trace requires health refresh before POST scan", () => {
  const result = summarizeStartTrace([
    { stage: "BUTTON_CLICKED", status: "PASS" },
    { stage: "READY_REQUEST_SENT", status: "PASS" },
    { stage: "BRIDGE_RECEIVED_READY", status: "PASS" },
    { stage: "EXTENSION_RECEIVED_READY", status: "PASS" },
    { stage: "EXTENSION_READY_RESULT", status: "PASS" },
    { stage: "BRIDGE_RETURNED_READY", status: "PASS" },
    { stage: "PAGE_RECEIVED_READY", status: "PASS" },
    { stage: "HEALTH_REFRESH_SENT", status: "PASS" },
    { stage: "HEALTH_REFRESH_RESPONSE", status: "FAIL", errorCode: "COLLECTOR_HEALTH_REFRESH_FAILED" },
  ]);
  assert.equal(result.lastSuccessful, "HEALTH_REFRESH_SENT");
  assert.equal(result.firstFailed, "HEALTH_REFRESH_RESPONSE");
  assert.equal(result.errorCode, "COLLECTOR_HEALTH_REFRESH_FAILED");
});
