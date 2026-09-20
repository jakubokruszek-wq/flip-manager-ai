/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({ globalThis: {}, Date, Map });
vm.runInContext(fs.readFileSync(path.join(__dirname, "collector-flow.js"), "utf8"), context);
const flow = context.globalThis.FlipCollectorFlow;

const PRODUCTION_LIMITS = { maxPosts: 150, minScrolls: 5, maxScrolls: 30, hardTimeBudgetMs: 110_000 };
const SEARCH_RESERVE_MS = 40_000;

test("NETWORK-FIRST is the default: search stays off unless explicitly enabled", () => {
  assert.equal(flow.isSearchPhaseEnabled(undefined), false);
  assert.equal(flow.isSearchPhaseEnabled({}), false);
  assert.equal(flow.isSearchPhaseEnabled({ searchPhaseEnabled: false }), false);
  assert.equal(flow.resolveAcquisitionMode({}), "NETWORK_FIRST");
});

test("SEARCH remains available for fallback when the flag is explicitly set", () => {
  assert.equal(flow.isSearchPhaseEnabled({ searchPhaseEnabled: true }), true);
  assert.equal(flow.resolveAcquisitionMode({ searchPhaseEnabled: true }), "SEARCH_ENABLED");
});

test("a truthy-but-not-true flag value never silently enables search", () => {
  for (const value of ["true", 1, {}, [], "yes"]) {
    assert.equal(flow.isSearchPhaseEnabled({ searchPhaseEnabled: value }), false);
  }
});

test("CURRENT_DEPTH reproduces today's feed budget exactly", () => {
  const depth = flow.resolveFeedDepth({ mode: "CURRENT_DEPTH", limits: PRODUCTION_LIMITS, searchReserveMs: SEARCH_RESERVE_MS, searchEnabled: true });
  assert.equal(depth.mode, "CURRENT_DEPTH");
  assert.equal(depth.budgetMs, 70_000, "110s hard budget minus the 40s search reserve, as in production today");
  assert.equal(depth.maxScrolls, 30);
  assert.equal(depth.maxPosts, 150);
});

test("DEEPER_NETWORK_FEED returns the search reserve to the feed once search is off", () => {
  const depth = flow.resolveFeedDepth({ mode: "DEEPER_NETWORK_FEED", limits: PRODUCTION_LIMITS, searchReserveMs: SEARCH_RESERVE_MS, searchEnabled: false });
  assert.equal(depth.mode, "DEEPER_NETWORK_FEED");
  assert.equal(depth.budgetMs, 110_000);
  assert.ok(depth.maxScrolls > PRODUCTION_LIMITS.maxScrolls);
  assert.ok(depth.maxPosts >= PRODUCTION_LIMITS.maxPosts);
});

test("deeper feed can never be combined with an enabled search phase", () => {
  const depth = flow.resolveFeedDepth({ mode: "DEEPER_NETWORK_FEED", limits: PRODUCTION_LIMITS, searchReserveMs: SEARCH_RESERVE_MS, searchEnabled: true });
  assert.equal(depth.mode, "CURRENT_DEPTH", "the reserve must stay reserved while search can still consume it");
  assert.equal(depth.budgetMs, 70_000);
});

test("a network-first scan with zero planned queries is COMPLETE, not PARTIAL", () => {
  assert.equal(flow.collectorOutcome(true, [], 0), "COMPLETE");
});

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
