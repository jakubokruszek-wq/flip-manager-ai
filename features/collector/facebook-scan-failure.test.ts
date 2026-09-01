import assert from "node:assert/strict";
import test from "node:test";
import { collectorScanFailurePatch, parseCollectorScanFailure } from "./facebook-scan-failure.ts";

test("collector failure payload preserves only safe timeout diagnostics", () => {
  const parsed = parseCollectorScanFailure(JSON.stringify({
    error: "COLLECT_SOURCE_RESPONSE_TIMEOUT",
    stage: "SEARCH_COLLECT_SOURCE",
    query: "mieszkanie",
    tabId: 77,
    elapsedMs: 25_003,
    source: "lodzsprzedazzakupwynajem",
    deviceToken: "must-not-survive",
  }));
  assert.deepEqual(parsed, {
    errorCode: "COLLECT_SOURCE_RESPONSE_TIMEOUT",
    stage: "SEARCH_COLLECT_SOURCE",
    query: "mieszkanie",
    tabId: 77,
    elapsedMs: 25_003,
    source: "lodzsprzedazzakupwynajem",
  });
});

test("collector failure patch makes the source terminal and keeps last-stage diagnostics", () => {
  const input = parseCollectorScanFailure(JSON.stringify({ error: "SOURCE_COLLECTION_DEADLINE_EXCEEDED", stage: "SEARCH", query: "mieszkanie", tabId: 8, elapsedMs: 180_001, source: "group" }));
  assert.deepEqual(collectorScanFailurePatch(input, { warnings: ["FACEBOOK_COLLECTOR_DISPATCH_PENDING"], diagnostics: [] }, "2026-09-01T12:00:00.000Z"), {
    status: "failed",
    finished_at: "2026-09-01T12:00:00.000Z",
    error_message: "COLLECTOR_SCAN_FAILED: SOURCE_COLLECTION_DEADLINE_EXCEEDED",
    warnings: ["FACEBOOK_COLLECTOR_DISPATCH_PENDING", "SOURCE_COLLECTION_DEADLINE_EXCEEDED"],
    diagnostics: [{ errorCode: "SOURCE_COLLECTION_DEADLINE_EXCEEDED", lastStage: "SEARCH", query: "mieszkanie", tabId: 8, elapsedMs: 180_001, source: "group", failedAt: "2026-09-01T12:00:00.000Z" }],
  });
});

test("failure parser rejects arbitrary error strings and credentials", () => {
  const parsed = parseCollectorScanFailure(JSON.stringify({ error: "token=secret", token: "secret", hmac: "secret" }));
  assert.equal(parsed.errorCode, "COLLECTOR_SCAN_FAILED");
  assert.equal("token" in parsed, false);
});
