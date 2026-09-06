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
    imageRule: null,
    deviceToken: "must-not-survive",
  }));
  assert.deepEqual(parsed, {
    errorCode: "COLLECT_SOURCE_RESPONSE_TIMEOUT",
    stage: "SEARCH_COLLECT_SOURCE",
    query: "mieszkanie",
    tabId: 77,
    elapsedMs: 25_003,
    source: "lodzsprzedazzakupwynajem",
    imageRule: null,
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

test("failure parser preserves only safe DNR diagnostics", () => {
  const parsed = parseCollectorScanFailure(JSON.stringify({
    error: "SOURCE_SCAN_IMAGE_RULE_INSTALL_FAILED",
    stage: "COLLECTOR_START_FAILED",
    tabId: 22,
    imageRule: {
      tabId: 22,
      ruleIds: [1700000044, "bad"],
      chromeErrorName: "TypeError",
      chromeErrorMessage: "Invalid value for resourceTypes",
      chromeRuntimeLastErrorMessage: "Invalid rule schema",
      options: {
        removeRuleIds: [1700000044],
        addRules: [{ id: 1700000044, priority: 1, action: { type: "block" }, condition: { tabIds: [22], resourceTypes: ["image"] } }],
      },
      runtime: { policyVersion: "SOURCE_SCAN_IMAGE_ONLY_V2", dnrAvailable: true, updateSessionRulesAvailable: true, getSessionRulesAvailable: true, manifestVersion: "0.1.0", dnrPermissionPresent: true },
      runtimeValues: { tabIdType: "number", tabIdIsInteger: true, ruleId: 1700000044, ruleIdType: "number", priority: 1, priorityType: "number" },
      installResult: "FAIL",
      sessionRulesBefore: [],
      sessionRulesAfter: [],
      targetRulePresentBefore: false,
      targetRulePresentAfter: false,
      duplicateAddRuleIds: false,
      deviceToken: "must-not-survive",
    },
  }));
  assert.equal(parsed.imageRule?.chromeErrorName, "TypeError");
  assert.equal(parsed.imageRule?.options?.addRules.length, 1);
  assert.equal(parsed.imageRule?.options?.addRules[0].action.type, "block");
  assert.equal(parsed.imageRule?.runtime?.dnrPermissionPresent, true);
  assert.equal(parsed.imageRule?.runtimeValues?.tabIdIsInteger, true);
  assert.equal(parsed.imageRule?.chromeRuntimeLastErrorMessage, "Invalid rule schema");
  assert.equal("deviceToken" in (parsed.imageRule as object), false);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive|deviceToken|secret|hmac/i);
});
