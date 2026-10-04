/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

/**
 * Real-browser proof for the stuck-scan report: "Finder shows a filter is
 * scanning, but it never progresses" (production screenshot: Allegro
 * Lokalnie stuck at 300 checked / 22 new with zero movement, "Skan tego
 * filtra już trwa" on retry). This drives the actual rendered FlipFinderPage
 * through the real client code (not a source-text check) against mocked
 * backend responses, proving: a click latches the button so a duplicate
 * click never fires a second POST; live polling updates are reflected on
 * screen as they arrive; completion, failure, and a stale/expired run each
 * release the latched state so the button is clickable again; and a fresh
 * click after release genuinely starts a new scan.
 */

const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-03T12:00:00.000Z";
const operatorSession = {
  access_token: "browser-test-access-token",
  refresh_token: "browser-test-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user: {
    id: "44444444-4444-4444-8444-444444444444",
    email: "operator@example.test",
    app_metadata: { role: "operator" },
    user_metadata: {},
    aud: "authenticated",
    created_at: now,
  },
};

const filter = {
  id: filterId,
  name: "Stuck scan regression filter",
  sources: ["allegro_lokalnie"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: null,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: now,
  updatedAt: now,
  totalMatches: 0,
  newMatches: 0,
  lastScan: null,
};

function listPayload() {
  return {
    filters: [filter],
    latestScan: null,
    summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 0, activeListings: 0, removedListings: 0, newMatches: 0 },
  };
}

const resultsPayload = {
  filter,
  results: [],
  reviewResults: [],
  archivedResults: [],
  counts: { active: 0, review: 0, archived: 0 },
  total: 0,
  newMatches: 0,
  lastScan: null,
  sourceScans: [],
};

const emptyOpenai = {
  lastRun: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" },
  today: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" },
  month: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" },
  monthlyBudgetUsd: null,
  remainingBudgetUsd: null,
  budgetUsedPercent: null,
  balanceUsd: null,
  balanceStatus: "UNAVAILABLE",
};

function baseProgress(runId, overrides) {
  return {
    runId,
    status: "running",
    startedAt: now,
    finishedAt: null,
    elapsedMs: 1_000,
    overall: { completedUnits: 0, totalUnits: 1, percent: 0, failedUnits: 0, remainingUnits: 1 },
    current: { source: "allegro_lokalnie", groupName: null },
    facebook: { totalGroups: 0, completedGroups: 0, runningGroups: 0, queuedGroups: 0, failedGroups: 0, discovered: 0, processed: 0, groups: [] },
    olx: { status: null, raw: 0, normalized: 0, processed: 0, errorMessage: null },
    totals: { scanned: 0, matched: 0, created: 0, updated: 0, priceDrops: 0 },
    collector: null,
    partialReason: null,
    errors: [],
    openai: emptyOpenai,
    ...overrides,
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500);
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready within 60 seconds");
}

test("the real Finder scan button latches on click, reflects live progress, and always releases -- on completion, on failure, and on a stale/expired run", { timeout: 600_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const authServer = http.createServer((request, response) => {
    if (request.url === "/auth/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(operatorSession.user));
      return;
    }
    if (request.url?.startsWith("/rest/v1/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    authServer.once("error", reject);
    authServer.listen(authPort, "127.0.0.1", resolve);
  });
  t.after(() => authServer.close());
  const childEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(), NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "browser-test-publishable-key" };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let buildOutput = "";
    build.stdout.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed with exit code ${code}; output: ${buildOutput}`))));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/flip-finder`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await browser.newPage();
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);

  let scanPostCount = 0;
  let runCounter = 0;
  /** @type {Record<string, any[]>} */
  const progressQueueByRun = {};
  /** @type {Record<string, number>} */
  const progressGetCountByRun = {};

  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listPayload()), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(resultsPayload), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/scan` && request.method() === "POST") {
      scanPostCount += 1;
      runCounter += 1;
      const runId = `run-${runCounter}`;
      // Each new run gets its own scripted sequence of progress snapshots,
      // popped one per poll -- the real client polls on a 1s interval, so
      // the LAST queued entry is held once exhausted (as the real server
      // would keep returning the same terminal/stalled row on every poll).
      progressQueueByRun[runId] = runCounter === 1
        ? [baseProgress(runId, { totals: { scanned: 100, matched: 2, created: 1, updated: 0, priceDrops: 0 } }), baseProgress(runId, { totals: { scanned: 300, matched: 5, created: 3, updated: 1, priceDrops: 0 } }), baseProgress(runId, { status: "completed", finishedAt: now, overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 0, remainingUnits: 0 }, totals: { scanned: 300, matched: 5, created: 3, updated: 1, priceDrops: 0 } })]
        : runCounter === 2
          ? [baseProgress(runId, { totals: { scanned: 50, matched: 0, created: 0, updated: 0, priceDrops: 0 } }), baseProgress(runId, { status: "failed", finishedAt: now, overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 1, remainingUnits: 0 }, errors: ["Allegro Lokalnie: SOURCE_FAILED"], totals: { scanned: 50, matched: 0, created: 0, updated: 0, priceDrops: 0 } })]
          : runCounter === 4
            ? [baseProgress(runId, { status: "partial", finishedAt: null, overall: { completedUnits: 1, totalUnits: 2, percent: 50, failedUnits: 0, remainingUnits: 1, waitingUnits: 1 }, current: { source: "official_uml", groupName: null }, totals: { scanned: 300, matched: 22, created: 22, updated: 0, priceDrops: 0 } })]
          // The third run simulates exactly the reported symptom: progress
          // genuinely stalls (same 300/22 numbers on every poll, never
          // moving), then the server-side heartbeat watchdog eventually
          // reclassifies the run as failed with the real timeout message --
          // proving the client's own polling loop does not spin forever.
          : [baseProgress(runId, { totals: { scanned: 300, matched: 22, created: 22, updated: 0, priceDrops: 0 } }), baseProgress(runId, { totals: { scanned: 300, matched: 22, created: 22, updated: 0, priceDrops: 0 } }), baseProgress(runId, { status: "failed", finishedAt: now, overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 1, remainingUnits: 0 }, errors: ["Scan timed out"], totals: { scanned: 300, matched: 22, created: 22, updated: 0, priceDrops: 0 } })];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ runId, status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 }), status: 202 });
    }
    const progressMatch = url.pathname.match(/^\/api\/flip-finder\/scans\/(run-\d+)$/);
    if (progressMatch) {
      const runId = progressMatch[1];
      progressGetCountByRun[runId] = (progressGetCountByRun[runId] ?? 0) + 1;
      const queue = progressQueueByRun[runId] ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(next ?? baseProgress(runId, {})), status: 200 });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const scanButton = page.getByRole("button", { name: /Skanuj teraz|Skanowanie…/i }).first();
  await scanButton.waitFor({ state: "visible", timeout: 60_000 });

  await t.test("A. clicking the button latches it immediately, so a rapid second click never fires a duplicate POST", async () => {
    await assert.equal(scanPostCount, 0);
    await scanButton.click();
    await page.getByRole("button", { name: "Skanowanie…" }).first().waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await scanButton.isDisabled(), true, "the button must be disabled the instant scanning starts, before any further click can land");
    await scanButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    assert.equal(scanPostCount, 1, "a disabled button must never allow a second POST for the same filter while one is already in flight");
  });

  await t.test("B. live polling progress is reflected on screen as new numbers arrive, not frozen at the first snapshot", async () => {
    await page.getByText(/300/).first().waitFor({ state: "visible", timeout: 15_000 });
    const bodyText = await page.locator("body").innerText();
    assert.match(bodyText, /300/, "the second, larger polled snapshot (300 scanned) must actually reach the DOM");
  });

  await t.test("C. completion releases the latch: the button is clickable again and shows a completion notice", async () => {
    await page.getByRole("button", { name: "Skanuj teraz" }).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await scanButton.isDisabled(), false, "after a completed terminal status the button must re-enable, never stay stuck latched");
    const bodyText = await page.locator("body").innerText();
    assert.match(bodyText, /Skan zakończony/i, "a real completion notice must appear, not silence");
  });

  await t.test("C2. once run-1 reaches its terminal (completed) status, the client's own polling loop stops issuing further GETs for it", async () => {
    const countAtTerminal = progressGetCountByRun["run-1"];
    assert.ok(countAtTerminal >= 3, "sanity check: all three scripted snapshots for run-1 must have actually been polled");
    // The real polling interval is 1s; waiting several intervals past the
    // terminal state must never see the count climb further -- this is the
    // literal proof that reaching a terminal status stops the GET loop,
    // not just that the UI happens to render a re-enabled button.
    await page.waitForTimeout(3_500);
    assert.equal(progressGetCountByRun["run-1"], countAtTerminal, "no further /api/flip-finder/scans/run-1 GET may fire once the run is terminal");
  });

  await t.test("D. a failed run also releases the latch instead of leaving the button stuck disabled", async () => {
    await scanButton.click();
    await page.getByRole("button", { name: "Skanowanie…" }).first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "Skanuj teraz" }).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await scanButton.isDisabled(), false, "a failed source must release scanning state exactly like a completed one -- never an indefinite lock");
    assert.equal(scanPostCount, 2, "run D must be its own fresh POST, proven separate from run A/B/C");
  });

  await t.test("E. a run that stalls at fixed numbers then times out server-side still releases the UI, and a fresh click after that genuinely starts a new scan", async () => {
    await scanButton.click();
    await page.getByRole("button", { name: "Skanowanie…" }).first().waitFor({ state: "visible", timeout: 10_000 });
    // The stalled run reports the exact same 300/22 numbers on repeated
    // polls (matching the real report) before the mocked backend watchdog
    // finally reclassifies it as failed -- the client must still reach a
    // terminal state and release, never spin on the frozen numbers forever.
    await page.getByRole("button", { name: "Skanuj teraz" }).first().waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await scanButton.isDisabled(), false, "a stalled-then-expired run must not leave the Finder page permanently showing 'Skanowanie…'");
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Skan tego filtra już trwa/, "once the UI has released the latch, it must never itself claim a scan is still running");
    const run3CountAtTerminal = progressGetCountByRun["run-3"];
    assert.ok(run3CountAtTerminal >= 3, "sanity check: the stalled run's scripted snapshots must have actually been polled");

    await scanButton.click();
    await page.waitForTimeout(500);
    assert.equal(scanPostCount, 4, "an expired/released scan must never block the next click from starting a genuine new scan");
    await page.getByText(/oczekuje na kontynuację/i).first().waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await scanButton.isDisabled(), false, "a durable continuation is waiting, not an active client-side scan lock");
    const run4CountAtWaiting = progressGetCountByRun["run-4"];
    assert.ok(run4CountAtWaiting >= 1, "the continuation snapshot must come from the backend progress endpoint");
    await page.waitForTimeout(1_500);
    assert.equal(progressGetCountByRun["run-4"], run4CountAtWaiting, "waiting-for-continuation must stop the client polling loop until the hourly worker resumes it");
    // run-3 is terminal and a fresh run-4 has started; polling the OLD run
    // must never resume, proving the client keyed its polling loop on the
    // specific run it started, not on "any active scan for this filter".
    await page.waitForTimeout(3_500);
    assert.equal(progressGetCountByRun["run-3"], run3CountAtTerminal, "no further GET for the old, already-terminal run-3 may fire once a new run has started");
  });
});
