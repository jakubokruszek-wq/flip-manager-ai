/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const content = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const runtimeSource = fs.readFileSync(path.join(__dirname, "collector-runtime.js"), "utf8");

test("SEARCH timing gives each query a 30-second active budget within a bounded phase", () => {
  assert.match(background, /hardTimeBudgetPerQueryMs: 30_000/);
  assert.match(background, /discoveryBudgetMs: 30_000/);
  assert.match(background, /hardTimeBudgetMs: 280_000/);
  assert.match(background, /ACTIVE_SEARCH_QUERIES = \["sprzedam", "na sprzeda\\u017c", "mieszkanie", "do remontu", "\\u0141\\u00f3d\\u017a", "2 pokoje", "3 pokoje"\]/);
  assert.ok(7 * 30_000 + 7 * 8_000 + 14_000 <= 280_000);
  assert.match(background, /discoveryDeadlineMs/);
  assert.match(background, /queryBudgetMs = Math\.min\(/);
  assert.match(background, /queryBudgetMs < SEARCH_LIMITS\.discoveryBudgetMs/);
  assert.match(background, /searchCollectionBudgetMs = Math\.max\(5_000, queryBudgetMs\)/);
  assert.match(background, /resolutionDeadlineMs/);
  assert.match(background, /MAX_DISCOVERY_MEDIA_TILES = 100/);
  assert.match(background, /maxDiscoveryMediaTiles: SEARCH_LIMITS\.maxDiscoveryMediaTiles/);
  assert.match(content, /candidateCapReached/);
  assert.match(content, /searchMediaTiles\.size < maxDiscoveryMediaTiles/);
  assert.match(content, /END_OF_RESULTS_CONFIRMED/);
  assert.doesNotMatch(content, /MAX_SEARCH_MEDIA_TILES/);
  assert.match(content, /collectSearchMediaTiles\(\)/);
  assert.match(background, /resolveSearchMediaTiles/);
  assert.match(content, /core\.shouldStopDiscovery/);
});

test("SEARCH sends have a 40-second ceiling while the source deadline remains 360 seconds", () => {
  assert.match(background, /COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS = 40_000/);
  assert.match(background, /SOURCE_COLLECTION_DEADLINE_MS = 360_000/);
  assert.match(background, /options\.searchMode\s*\?\s*COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS/);
  assert.match(background, /SOURCE_COLLECTION_DEADLINE_EXCEEDED/);
});

test("a hung content response is still rejected by the hard timeout", async () => {
  const context = vm.createContext({ globalThis: {}, Promise, Error, setTimeout, clearTimeout, Date });
  vm.runInContext(runtimeSource, context);
  await assert.rejects(
    context.globalThis.FlipCollectorRuntime.sendMessageWithTimeout(
      () => new Promise(() => {}),
      { timeoutMs: 10, timeoutCode: "COLLECT_SOURCE_RESPONSE_TIMEOUT", diagnostics: { query: "mieszkanie", tabId: 1 } },
    ),
    { message: "COLLECT_SOURCE_RESPONSE_TIMEOUT" },
  );
});
