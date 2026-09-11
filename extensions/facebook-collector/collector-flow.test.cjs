/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({ globalThis: {}, Date, Map });
vm.runInContext(fs.readFileSync(path.join(__dirname, "collector-flow.js"), "utf8"), context);
const flow = context.globalThis.FlipCollectorFlow;

test("MAIN FEED success and seven healthy SEARCH queries complete", () => {
  assert.equal(flow.collectorOutcome(true, Array.from({ length: 7 }, () => ({ executed: true, status: "HEALTHY" })), 7), "COMPLETE");
});

test("MAIN FEED survives a partial or timed-out SEARCH", () => {
  const sixOfSeven = Array.from({ length: 7 }, (_, index) => ({ executed: index < 6, status: index < 6 ? "HEALTHY" : "DEGRADED" }));
  assert.equal(flow.collectorOutcome(true, sixOfSeven, 7), "PARTIAL");
  assert.equal(flow.searchFailureDisposition("COLLECT_SOURCE_RESPONSE_TIMEOUT"), "CONTINUE");
  assert.equal(flow.collectorOutcome(true, [{ executed: true, status: "FAILED" }], 7), "PARTIAL");
});

test("missing MAIN FEED is failed and a source deadline stops SEARCH", () => {
  assert.equal(flow.collectorOutcome(false, [], 7), "FAILED");
  assert.equal(flow.searchFailureDisposition("SOURCE_COLLECTION_DEADLINE_EXCEEDED"), "STOP");
});

test("stage telemetry is bounded and terminal", () => {
  let now = Date.parse("2026-09-11T20:00:00.000Z");
  const timeline = flow.createStageTimeline(() => now);
  timeline.start("MAIN_FEED_START"); now += 125; timeline.finish("MAIN_FEED_START", "PASS");
  assert.deepEqual(JSON.parse(JSON.stringify(timeline.snapshot())), [{ stage: "MAIN_FEED_START", startedAt: "2026-09-11T20:00:00.000Z", finishedAt: "2026-09-11T20:00:00.125Z", elapsedMs: 125, status: "PASS", errorCode: null }]);
});
