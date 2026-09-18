import assert from "node:assert/strict";
import test from "node:test";
import { FACEBOOK_SOURCE_NOT_CONFIGURED_CODE, facebookScanStartFailure, scanStartErrorMessage, scanStatus } from "./scan-start-errors.ts";

test("collector offline is a controlled service-unavailable response", () => {
  assert.equal(scanStatus(Object.assign(new Error("COLLECTOR_OFFLINE"), { status: 503 })), 503);
});

test("unknown scan start failures never default to gateway 502", () => {
  assert.equal(scanStatus(new Error("unexpected failure")), 500);
});

test("SCAN START REGRESSION: no enabled allowlisted Facebook group is a controlled 503, not a generic 500", () => {
  const classified = facebookScanStartFailure("FACEBOOK_PRODUCTION_SOURCE_NOT_CONFIGURED");
  assert.deepEqual(classified, { status: 503, code: FACEBOOK_SOURCE_NOT_CONFIGURED_CODE });
});

test("SCAN START REGRESSION: the not-configured failure reaches the user as actionable Polish, never as an internal token", () => {
  const message = scanStartErrorMessage(FACEBOOK_SOURCE_NOT_CONFIGURED_CODE);
  assert.notEqual(message, FACEBOOK_SOURCE_NOT_CONFIGURED_CODE);
  assert.match(message, /grupa Facebooka/);
  assert.doesNotMatch(message, /[A-Z]{4,}_[A-Z_]+/);
});

test("collector offline and readiness failures keep their existing codes and status", () => {
  assert.deepEqual(facebookScanStartFailure("COLLECTOR_OFFLINE"), { status: 503, code: "COLLECTOR_OFFLINE" });
  assert.deepEqual(facebookScanStartFailure("COLLECTOR_READINESS_QUERY_FAILED: timeout"), { status: 503, code: "COLLECTOR_READINESS_UNAVAILABLE" });
  assert.equal(scanStartErrorMessage("COLLECTOR_OFFLINE"), "Facebook Collector jest offline lub nie ma świeżego heartbeat.");
});

test("unrelated source failures stay unclassified so they keep the generic 500 path", () => {
  assert.equal(facebookScanStartFailure("OLX_ENQUEUE_FAILED"), null);
  assert.equal(facebookScanStartFailure(null), null);
  assert.equal(scanStartErrorMessage("Nie znaleziono filtra."), "Nie znaleziono filtra.");
});
