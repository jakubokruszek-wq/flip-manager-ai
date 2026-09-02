/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const runtime = fs.readFileSync(path.join(__dirname, "collector-runtime.js"), "utf8");
const preflight = fs.readFileSync(path.join(__dirname, "collector-preflight.js"), "utf8");
const content = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
const pairing = fs.readFileSync(path.join(__dirname, "pairing.js"), "utf8");
const options = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "options.html"), "utf8");
const bridge = fs.readFileSync(path.join(__dirname, "collector-bridge.js"), "utf8");
const bootstrap = fs.readFileSync(path.join(__dirname, "bootstrap.js"), "utf8");
const finderPage = fs.readFileSync(path.join(__dirname, "../../features/flip-finder/components/flip-finder-page.tsx"), "utf8");
const manualScan = fs.readFileSync(path.join(__dirname, "../../features/flip-finder/server/manual-scan.ts"), "utf8");
const scanProgressServer = fs.readFileSync(path.join(__dirname, "../../features/flip-finder/server/scan-progress.ts"), "utf8");
const failRoute = fs.readFileSync(path.join(__dirname, "../../app/api/collector/facebook/scans/[scanId]/fail/route.ts"), "utf8");
const collectorClaimRoute = fs.readFileSync(path.join(__dirname, "../../app/api/collector/jobs/claim/route.ts"), "utf8");
const legacyClaimRoute = fs.readFileSync(path.join(__dirname, "../../app/api/facebook-worker/claim/route.ts"), "utf8");
const workerJobs = fs.readFileSync(path.join(__dirname, "../../features/facebook-worker/jobs.ts"), "utf8");

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

test("Flip Finder bootstrap starts the production collector after readiness verification", () => {
  assert.ok(manifest.content_scripts.map((item) => item.js || []).flat().includes("bootstrap.js"));
  assert.match(bootstrap, /FLIP_COLLECTOR_READY_REQUEST/);
  assert.match(bootstrap, /CHECK_COLLECTOR_READY/);
  assert.match(bootstrap, /FLIP_COLLECTOR_SCAN_REQUEST/);
  assert.match(bootstrap, /COLLECT_PRODUCTION_SOURCE/);
  assert.match(background, /COLLECT_PRODUCTION_SOURCE/);
  assert.match(background, /CHECK_COLLECTOR_READY/);
  assert.match(bootstrap, /requestId/);
  assert.match(background, /RECORD_START_TRACE/);
  assert.match(background, /collectorStartTraces/);
});

test("production scan start uses only the backend Facebook queue", () => {
  const scanHandler = finderPage.slice(finderPage.indexOf("const scanFilter = async"), finderPage.indexOf("const validateCollector = async"));
  assert.match(scanHandler, /POST_SCAN_SENT/);
  assert.match(scanHandler, /oczekiwanie na odebranie zlecenia przez Collector/);
  assert.doesNotMatch(scanHandler, /requestCollectorBridgePing|requestCollectorReady|requestCollectorHealthRefresh|requestCollectorScan|SCAN_COMMAND_SENT/);
  assert.match(manualScan, /enqueueFacebookJobs\(filter, runId\)/);
  assert.doesNotMatch(manualScan, /enqueueFacebookCollectorScan/);
  assert.match(scanProgressServer, /FACEBOOK_PENDING_TIMEOUT_MS = 90_000/);
  assert.match(scanProgressServer, /COLLECTOR_NOT_AVAILABLE/);
});

test("health preflight always refreshes stale or healthy pairing and fails closed", async () => {
  const context = vm.createContext({ globalThis: {}, Promise, Error });
  vm.runInContext(preflight, context);
  const api = context.globalThis.FlipCollectorStartPreflight;
  for (const lastHeartbeatAt of ["2026-09-01T19:45:00.000Z", "2026-09-01T19:59:59.000Z"]) {
    let heartbeatCalls = 0;
    const traces = [];
    const result = await api.refreshCollectorHealth({
      requestId: "ba21143f-d803-4a8c-aa4c-462d76d765f7",
      readPairing: async () => ({ collectorPairingState: { lastHeartbeatAt } }),
      localPairingStatus: () => ({ status: "CONNECTED", label: "Połączono" }),
      heartbeat: async (timeoutMs) => { heartbeatCalls += 1; assert.equal(timeoutMs, 6_000); },
      persistVerification: async () => ({ status: "CONNECTED", label: "Połączono", lastHeartbeatAt: "2026-09-01T20:00:00.000Z" }),
      verificationOutcome: () => ({ kind: "TEMPORARY_FAILURE" }),
      trace: async (...args) => { traces.push(args); },
    });
    assert.equal(heartbeatCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.heartbeatUpdated, true);
    assert.ok(traces.some((trace) => trace[1] === "HEARTBEAT_UPDATED" && trace[2] === "PASS"));
  }

  let missingHeartbeatCalls = 0;
  const missing = await api.refreshCollectorHealth({
    requestId: "ba21143f-d803-4a8c-aa4c-462d76d765f7",
    readPairing: async () => ({}),
    localPairingStatus: () => ({ status: "DISCONNECTED", label: "Niepołączono" }),
    heartbeat: async () => { missingHeartbeatCalls += 1; },
    persistVerification: async () => ({}),
    verificationOutcome: () => ({ kind: "TEMPORARY_FAILURE" }),
    trace: async () => {},
  });
  assert.equal(missingHeartbeatCalls, 0);
  assert.equal(missing.error, "PAIRING_MISSING");

  const backendFailure = await api.refreshCollectorHealth({
    requestId: "ba21143f-d803-4a8c-aa4c-462d76d765f7",
    readPairing: async () => ({}),
    localPairingStatus: () => ({ status: "CONNECTED", label: "Połączono" }),
    heartbeat: async () => { throw new Error("backend unavailable"); },
    persistVerification: async () => ({ status: "UNVERIFIED", label: "Połączenie niezweryfikowane" }),
    verificationOutcome: () => ({ kind: "TEMPORARY_FAILURE" }),
    trace: async () => {},
  });
  assert.equal(backendFailure.ok, false);
  assert.equal(backendFailure.heartbeatUpdated, false);
  assert.equal(backendFailure.error, "COLLECTOR_HEALTH_REFRESH_FAILED");
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
  for (const stage of ["EXTENSION_RECEIVED_READY", "EXTENSION_READY_RESULT", "EXTENSION_RECEIVED_SCAN_COMMAND", "COLLECTOR_STARTED", "COLLECT_SOURCE_SENT", "COLLECT_SOURCE_RESPONSE", "COLLECT_SOURCE_TIMEOUT", "COLLECTOR_BATCH_CREATED"]) assert.match(background + content + bridge, new RegExp(stage));
  assert.match(background, /safeRequestId/);
  assert.match(background, /collectorStartTraces/);
  assert.match(bridge, /requestId/);
  assert.doesNotMatch(background, /collectorStartTraces[\s\S]{0,200}deviceToken/);
});

test("COLLECT_SOURCE response and whole-source deadlines are hard, terminal and fail-closed", () => {
  assert.match(background, /importScripts\("collector-runtime\.js"\)/);
  assert.match(background, /COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS = 25_000/);
  assert.match(background, /SOURCE_COLLECTION_DEADLINE_MS = 180_000/);
  assert.match(background, /sendMessageWithTimeout/);
  assert.match(background + runtime, /COLLECT_SOURCE_RESPONSE_TIMEOUT/);
  assert.match(background + runtime, /SOURCE_COLLECTION_DEADLINE_EXCEEDED/);
  assert.match(background, /chrome\.tabs\.remove\(tab\.id\)/);
  assert.match(background, /failCollectorScan\(scanId, error, diagnostics\)/);
  assert.match(failRoute, /collectorScanFailurePatch/);
  assert.match(failRoute, /\.in\("status", \["pending", "running"\]\)/);
  assert.doesNotMatch(runtime, /deviceToken|hmac|cookie/i);
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

test("finder bootstrap is matched at document start and owns the direct runtime path", () => {
  const finder = manifest.content_scripts.find((item) => (item.js || []).includes("bootstrap.js"));
  assert.ok(finder);
  assert.ok(finder.matches.includes("https://flip-manager-ai.vercel.app/flip-finder*"));
  assert.equal(finder.run_at, "document_start");
  assert.match(background, /isFinderUrl/);
  assert.match(background, /FIND-ER_ORIGIN|FINDER_ORIGIN/);
  assert.deepEqual(finder.js, ["bootstrap.js"]);
  assert.match(bootstrap, /FLIP_COLLECTOR_BOOTSTRAP_PING/);
  assert.match(bootstrap, /FLIP_COLLECTOR_BOOTSTRAP_PONG/);
  assert.match(bootstrap, /BOOTSTRAP_RUNTIME_PING/);
  assert.match(bootstrap, /FLIP_COLLECTOR_BOOTSTRAP_LOADED/);
  assert.match(bootstrap, /flipCollectorBootstrap/);
  assert.match(bootstrap, /setAttribute\("data-flip-collector-bootstrap"/);
  assert.match(bootstrap, /\[0, 50, 250\]/);
  assert.match(bootstrap, /safeRequestId/);
  assert.match(bootstrap, /EXTENSION_CONTEXT_INVALIDATED/);
  assert.match(bootstrap, /\.catch\(\(error\) => invalidateBootstrap/);
  assert.match(background, /RUNTIME_GENERATION/);
  assert.match(background, /recoverFinderBootstraps/);
  assert.match(background, /files: \["bootstrap\.js"\]/);
  assert.match(background, /recoverFinderBootstraps\(\)\.catch/);
  assert.doesNotMatch(bootstrap, /deviceToken|secret|hmac|cookie/i);
  assert.match(background, /BOOTSTRAP_ORIGIN_NOT_ALLOWED/);
  assert.match(bootstrap, /LISTENER_REGISTERED/);
  assert.match(bootstrap, /PAGE_MESSAGE_RECEIVED/);
  assert.match(finderPage, /waitForCollectorBootstrap/);
  assert.match(finderPage, /getAttribute\("data-flip-collector-bootstrap"\)/);
  assert.doesNotMatch(finderPage, /BOOTSTRAP_MARKER_MISSING/);
  assert.match(finderPage, /BOOTSTRAP_START_TIMEOUT/);
});

test("page and bootstrap use the same literal PING and PONG event names", () => {
  for (const eventName of ["FLIP_COLLECTOR_BOOTSTRAP_PING", "FLIP_COLLECTOR_BOOTSTRAP_PONG"]) {
    assert.match(finderPage, new RegExp(eventName));
    assert.match(bootstrap, new RegExp(eventName));
  }
});

test("bootstrap registers synchronously and answers PING before background health resolves", async () => {
  const listeners = [];
  const posted = [];
  const beacons = [];
  let resolveHealth;
  const documentListeners = [];
  const document = { documentElement: { setAttribute() {} }, addEventListener(type, listener) { if (type === "flip-collector-bootstrap-ping") documentListeners.push(listener); }, removeEventListener() {}, dispatchEvent(event) { posted.push({ message: event.detail }); } };
  const window = { addEventListener(type, listener) { if (type === "message") listeners.push(listener); }, removeEventListener() {}, postMessage(message, origin) { posted.push({ message, origin }); } };
  const runtime = { lastError: null, sendMessage(message, callback) { if (message.type === "BOOTSTRAP_CONTEXT_HEALTH") resolveHealth = callback; else callback({ ok: true, requestId: message.requestId }); } };
  const storage = { local: { set(value) { beacons.push(...Object.values(value)); return Promise.resolve(); } } };
  const context = vm.createContext({ globalThis: {}, window, document, location: { origin: "https://flip-manager-ai.vercel.app" }, console: { debug() {} }, chrome: { runtime, storage }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, Promise, Error, Set, Date, setTimeout });

  vm.runInContext(bootstrap, context);
  assert.equal(documentListeners.length, 1);
  assert.equal(typeof resolveHealth, "function");
  assert.equal(beacons[0].stage, "LISTENER_REGISTERED");

  const requestId = "22e13376-771d-4a9a-aee7-61189d71d62e";
  documentListeners[0]({ target: document, detail: { type: "FLIP_COLLECTOR_BOOTSTRAP_PING", requestId } });
  assert.ok(posted.some(({ message }) => message.type === "FLIP_COLLECTOR_BOOTSTRAP_PONG" && message.requestId === requestId && message.ok === true));
  assert.ok(beacons.some((beacon) => beacon.stage === "BOOTSTRAP_EVENT_RECEIVED" && beacon.requestId === requestId && beacon.eventType === "FLIP_COLLECTOR_BOOTSTRAP_PING"));

  resolveHealth({ ok: true, runtimeGeneration: "generation-delayed" });
  await new Promise((resolve) => setImmediate(resolve));
});

test("bootstrap executes, is idempotent and round-trips exact request ids", async () => {
  const listeners = [];
  const posted = [];
  const runtimeMessages = [];
  const attributes = {};
  const documentListeners = [];
  const document = { documentElement: { dataset: {}, setAttribute(name, value) { attributes[name] = value; this.dataset.flipCollectorBootstrap = value; }, getAttribute(name) { return attributes[name] || null; } }, addEventListener(type, listener) { if (type === "flip-collector-bootstrap-ping") documentListeners.push(listener); }, removeEventListener(type, listener) { if (type === "flip-collector-bootstrap-ping") { const index = documentListeners.indexOf(listener); if (index >= 0) documentListeners.splice(index, 1); } }, dispatchEvent(event) { posted.push({ message: event.detail }); } };
  const window = { addEventListener(type, listener) { if (type === "message") listeners.push(listener); }, removeEventListener(type, listener) { if (type === "message") { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } }, postMessage(message, origin) { posted.push({ message, origin }); } };
  const context = vm.createContext({ globalThis: {}, window, document, location: { origin: "https://flip-manager-ai.vercel.app" }, console: { debug() {} }, chrome: { runtime: { lastError: null, sendMessage(message, callback) { runtimeMessages.push(message); callback(message.type === "BOOTSTRAP_CONTEXT_HEALTH" ? { ok: true, runtimeGeneration: "generation-1" } : { ok: true, requestId: message.requestId }); } } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, Promise, Error, Set, setTimeout });
  vm.runInContext(bootstrap, context);
  vm.runInContext(bootstrap, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.getAttribute("data-flip-collector-bootstrap"), "generation-1");
  assert.equal(documentListeners.length, 1);
  delete attributes["data-flip-collector-bootstrap"];
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(document.documentElement.getAttribute("data-flip-collector-bootstrap"), "generation-1");
  const requestId = "10da2d3e-23be-4e39-9625-02d33984692d";
  documentListeners[0]({ target: document, detail: { type: "FLIP_COLLECTOR_BOOTSTRAP_PING", requestId } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runtimeMessages.some((message) => message.type === "BOOTSTRAP_RUNTIME_PING" && message.requestId === requestId));
  assert.ok(posted.some(({ message }) => message.type === "FLIP_COLLECTOR_BOOTSTRAP_PONG" && message.requestId === requestId));
  const before = posted.length;
  assert.equal(posted.length, before);
});

test("invalidated bootstrap becomes stale and a new runtime generation replaces it", async () => {
  const listeners = [];
  const posted = [];
  const attributes = {};
  const documentListeners = [];
  const document = { documentElement: { dataset: {}, setAttribute(name, value) { attributes[name] = value; this.dataset.flipCollectorBootstrap = value; }, getAttribute(name) { return attributes[name] || null; } }, addEventListener(type, listener) { if (type === "flip-collector-bootstrap-ping") documentListeners.push(listener); }, removeEventListener(type, listener) { if (type === "flip-collector-bootstrap-ping") { const index = documentListeners.indexOf(listener); if (index >= 0) documentListeners.splice(index, 1); } }, dispatchEvent(event) { posted.push(event.detail); } };
  const window = { addEventListener(type, listener) { if (type === "message") listeners.push(listener); }, removeEventListener(type, listener) { if (type === "message") { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } }, postMessage(message) { posted.push(message); } };
  let generation = "generation-1";
  let invalidated = false;
  const runtime = { lastError: null, sendMessage(message, callback) { if (invalidated) throw new Error("Extension context invalidated."); if (message.type === "BOOTSTRAP_CONTEXT_HEALTH") callback({ ok: true, runtimeGeneration: generation }); else if (message.type === "CHECK_COLLECTOR_READY") callback({ ok: true, status: "CONNECTED" }); else callback({ ok: true, requestId: message.requestId }); } };
  const context = vm.createContext({ globalThis: {}, window, document, location: { origin: "https://flip-manager-ai.vercel.app" }, console: { debug() {} }, chrome: { runtime }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, Promise, Error, Set, setTimeout });
  vm.runInContext(bootstrap, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.getAttribute("data-flip-collector-bootstrap"), "generation-1");
  assert.equal(documentListeners.length, 1);

  invalidated = true;
  vm.runInContext(bootstrap, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.getAttribute("data-flip-collector-bootstrap"), "stale");
  assert.equal(documentListeners.length, 0);

  invalidated = false;
  generation = "generation-2";
  vm.runInContext(bootstrap, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.getAttribute("data-flip-collector-bootstrap"), "generation-2");
  assert.equal(documentListeners.length, 1);
  const requestId = "10da2d3e-23be-4e39-9625-02d33984692d";
  documentListeners[0]({ target: document, detail: { type: "FLIP_COLLECTOR_BOOTSTRAP_PING", requestId } });
  documentListeners[0]({ target: document, detail: { type: "FLIP_COLLECTOR_READY_REQUEST", requestId } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(posted.some((message) => message.type === "FLIP_COLLECTOR_BOOTSTRAP_PONG" && message.requestId === requestId));
  assert.ok(posted.some((message) => message.type === "FLIP_COLLECTOR_READY_RESULT" && message.requestId === requestId && message.ok === true));
});

test("extension UI never reads or renders the device token", () => {
  assert.doesNotMatch(popup, /deviceToken/);
  assert.doesNotMatch(options, /deviceToken/);
  assert.doesNotMatch(optionsHtml, /deviceToken|Device token/i);
  assert.match(pairing, /deviceToken: data\.deviceToken/);
  assert.doesNotMatch(pairing, /FLIP_COLLECTOR_STATUS_RESULT[\s\S]{0,500}deviceToken/);
});

test("collector validator is explicit, bounded and does not start collection", () => {
  assert.match(background, /VALIDATE_COLLECTOR/);
  assert.match(background, /COLLECTOR_SELF_TEST/);
  assert.match(background, /api\/collector\/readiness/);
  assert.match(background, /CONTENT_SCRIPT_RESPONSE_TIMEOUT/);
  assert.match(background, /waitForContentScript\(tabId, 10_000\)/);
  assert.match(content, /COLLECTOR_SELF_TEST/);
  assert.match(content, /documentReadyState/);
  assert.match(finderPage, /Waliduj Collector/);
  assert.match(finderPage, /COLLECTOR_VALIDATION_RESPONSE/);
});

test("external proof-of-concept channel is origin-bound and harmless", () => {
  assert.deepEqual(manifest.externally_connectable.matches, ["https://flip-manager-ai.vercel.app/*", "http://localhost:3000/*"]);
  assert.match(background, /onMessageExternal/);
  assert.match(background, /FLIP_COLLECTOR_EXTERNAL_PING/);
  assert.match(background, /FLIP_COLLECTOR_EXTERNAL_PONG/);
  assert.match(background, /isAllowedExternalSender/);
  assert.match(finderPage, /koaaacaocmeohmajkpmblkmleedjeeih/);
  assert.match(finderPage, /Test kanału bezpośredniego/);
});

test("backend collector queue polling is bounded and independent of page messaging", () => {
  assert.match(background, /collector-job-poll/);
  assert.match(background, /api\/collector\/jobs\/claim/);
  assert.match(background, /COLLECTOR_SELF_TEST/);
  assert.match(background, /pollCollectorJobs/);
  assert.match(collectorClaimRoute, /FACEBOOK_COLLECTOR_QUEUE_ENABLED/);
  assert.match(collectorClaimRoute, /NO_PENDING_JOB/);
  assert.match(collectorClaimRoute, /BROWSER_EXTENSION/);
  assert.match(legacyClaimRoute, /LEGACY_WORKER/);
  assert.match(workerJobs, /p_consumer_type/);
});
