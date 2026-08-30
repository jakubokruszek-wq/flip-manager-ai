/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const content = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
const pairing = fs.readFileSync(path.join(__dirname, "pairing.js"), "utf8");
const options = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "options.html"), "utf8");
const bridge = fs.readFileSync(path.join(__dirname, "collector-bridge.js"), "utf8");
const bootstrap = fs.readFileSync(path.join(__dirname, "bootstrap.js"), "utf8");

test("declares scripting permission for bounded fallback injection", () => {
  assert.ok(manifest.permissions.includes("scripting"));
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /Math\.min\(10,/);
});

test("production active-source flow is allowlisted, deep, single-click and bounded", () => {
  assert.match(background, /lodzsprzedazzakupwynajem/);
  assert.match(background, /minScrolls: 5/);
  assert.match(background, /maxScrolls: 30/);
  assert.match(background, /hardTimeBudgetMs: 110_000/);
  assert.match(background, /ACTIVE_SEARCH_QUERIES/);
  assert.match(background, /PRODUCTION_SOURCE_NOT_ALLOWED/);
  assert.match(background, /importScripts\("collector-core\.js"\)/);
  assert.match(background, /do remontu/);
});

test("search fallback has bounded media-tile resolution budgets", () => {
  assert.match(background, /SEARCH_LIMITS = \{ minScrolls: 0, maxScrolls: 3, maxUniquePerQuery: 10, maxTilesToOpen: 10, tileConcurrency: 1, hardTimeBudgetPerQueryMs: 15_000, discoveryBudgetMs: 5_000, hardTimeBudgetMs: 90_000 \}/);
  assert.match(background, /minScrolls: SEARCH_LIMITS\.minScrolls/);
  assert.match(background, /maxScrolls: SEARCH_LIMITS\.maxScrolls/);
  assert.match(background, /maxPosts: SEARCH_LIMITS\.maxUniquePerQuery/);
  assert.match(background, /maxMediaTiles: SEARCH_LIMITS\.maxTilesToOpen/);
  assert.match(background, /COLLECTOR_SEARCH_GLOBAL_TIME_BUDGET/);
  assert.match(background, /COLLECTOR_SEARCH_QUERY_DEGRADED/);
  assert.match(background, /appendUnexecutedSearchRuns/);
  assert.match(background, /resolveSearchMediaTiles/);
  assert.match(background, /RESOLVE_SEARCH_MEDIA_TILE/);
  assert.match(background, /Math\.min\(SEARCH_LIMITS\.tileConcurrency, selected\.length\)/);
  assert.doesNotMatch(background, /Promise\.all\(selected\.map/);
});

test("search telemetry records coverage, main duplicates, contribution and stop reason", () => {
  for (const field of ["query", "scrolls", "visibleCards", "captured", "unique", "duplicatesVsMainFeed", "uniqueContribution", "sellContribution", "tilesSeen", "tilesOpened", "tilesResolved", "tilesUnverified", "uniqueParentPosts", "verifiedParentPosts", "duplicatesByMedia", "durationMs", "stopReason"]) {
    assert.match(background, new RegExp(`\\b${field}\\b`));
  }
  assert.match(background, /searchTelemetry: searchTelemetrySummary/);
});

test("media tile resolver is exact, fail-closed and never forwards tile media as gallery provenance", () => {
  assert.match(content, /current\.searchParams\.get\("fbid"\) !== mediaId/);
  assert.match(content, /verifySearchMediaParent/);
  assert.doesNotMatch(content, /postId:\s*mediaId/);
});

test("Flip Finder bridge starts the production collector after readiness verification", () => {
  assert.ok(manifest.content_scripts.map((item) => item.js || []).flat().includes("collector-bridge.js"));
  assert.match(bridge, /FLIP_COLLECTOR_READY_REQUEST/);
  assert.match(bridge, /CHECK_COLLECTOR_READY/);
  assert.match(bridge, /FLIP_COLLECTOR_SCAN_REQUEST/);
  assert.match(bridge, /COLLECT_PRODUCTION_SOURCE/);
  assert.match(background, /COLLECT_PRODUCTION_SOURCE/);
  assert.match(background, /CHECK_COLLECTOR_READY/);
  assert.match(bridge, /requestId/);
  assert.match(background, /RECORD_START_TRACE/);
  assert.match(background, /collectorStartTraces/);
});

test("pairing status autoload uses signed backend verification in popup and setup", () => {
  assert.match(background, /GET_PAIRING_STATUS/);
  assert.match(background, /VERIFY_PAIRING_STATUS/);
  assert.match(background, /signedPost\(`\$\{apiUrl\}\/api\/collector\/heartbeat`/);
  assert.match(popup, /void loadPairingStatus\(\)/);
  assert.match(pairing, /FLIP_COLLECTOR_STATUS_REQUEST/);
  assert.match(pairing, /FLIP_COLLECTOR_STATUS_RESULT/);
});

test("start trace uses request ids, bounded safe stages and never stores credentials", () => {
  for (const stage of ["EXTENSION_RECEIVED_READY", "EXTENSION_READY_RESULT", "EXTENSION_RECEIVED_SCAN_COMMAND", "COLLECTOR_STARTED", "COLLECTOR_BATCH_CREATED"]) assert.match(background + content + bridge, new RegExp(stage));
  assert.match(background, /safeRequestId/);
  assert.match(background, /collectorStartTraces/);
  assert.match(bridge, /requestId/);
  assert.doesNotMatch(background, /collectorStartTraces[\s\S]{0,200}deviceToken/);
});

test("bridge exposes an independent request-id ping and explicit runtime error path", () => {
  assert.match(bridge, /FLIP_COLLECTOR_BRIDGE_PING/);
  assert.match(bridge, /FLIP_COLLECTOR_BRIDGE_PONG/);
  assert.match(bridge, /BRIDGE_PING_RECEIVED/);
  assert.match(bridge, /BRIDGE_PONG_SENT/);
  assert.match(bridge, /requestId/);
  assert.match(bridge, /catch/);
  assert.match(bridge, /chrome\.runtime\.sendMessage/);
});

test("finder bridge is matched at document start and recovery is bounded to canonical origin", () => {
  const finder = manifest.content_scripts.find((item) => (item.js || []).includes("collector-bridge.js"));
  assert.ok(finder);
  assert.ok(finder.matches.includes("https://flip-manager-ai.vercel.app/flip-finder*"));
  assert.equal(finder.run_at, "document_start");
  assert.match(background, /chrome\.runtime\.onInstalled/);
  assert.match(background, /chrome\.runtime\.onStartup/);
  assert.match(background, /recoverFinderBridges/);
  assert.match(background, /isFinderUrl/);
  assert.match(background, /FIND-ER_ORIGIN|FINDER_ORIGIN/);
  assert.match(bridge, /__flipCollectorBridgeInstalled/);
  assert.ok(finder.js.includes("bootstrap.js"));
  assert.match(bootstrap, /FLIP_COLLECTOR_BOOTSTRAP_PING/);
  assert.match(bootstrap, /RECOVER_COLLECTOR_BRIDGE/);
  assert.match(bootstrap, /FLIP_COLLECTOR_BOOTSTRAP_PONG/);
  assert.match(bootstrap, /safeRequestId/);
  assert.doesNotMatch(bootstrap, /deviceToken|secret|hmac|cookie/i);
  assert.match(background, /COLLECTOR_BRIDGE_ORIGIN_NOT_ALLOWED/);
});

test("extension UI never reads or renders the device token", () => {
  assert.doesNotMatch(popup, /deviceToken/);
  assert.doesNotMatch(options, /deviceToken/);
  assert.doesNotMatch(optionsHtml, /deviceToken|Device token/i);
  assert.match(pairing, /deviceToken: data\.deviceToken/);
  assert.doesNotMatch(pairing, /FLIP_COLLECTOR_STATUS_RESULT[\s\S]{0,500}deviceToken/);
});
