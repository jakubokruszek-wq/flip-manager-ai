/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

/**
 * Real-browser proof for the Finder/Watcher separation mission -- not a
 * source-text check. This deliberately mocks the scan-progress API to
 * return a payload FULL of Facebook Watcher data (real group names, a
 * per-group breakdown, a COLLECTOR_NOT_AVAILABLE error) -- exactly the
 * shape a Watcher-owned scan_run_id's response would have, and exactly
 * what a production screenshot showed leaking into Finder's own panel
 * before the fix. If the fix only worked "on paper" (e.g. a regex the
 * component's real render logic didn't actually honor), this test would
 * still see the leaked text/data in the live DOM. It must not.
 */

const filterId = "11111111-1111-4111-8111-111111111111";
const financeRunId = "22222222-2222-4222-8222-222222222222";
const watcherRunId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-27T12:00:00.000Z";
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
  name: "Isolation test filter",
  sources: ["facebook"],
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
  maxPricePerSqm: 12_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
  totalMatches: 0,
  newMatches: 0,
  // The exact leak vector this fix removed: a filter's lastScan can belong
  // to the Watcher's OWN independent scheduler cycle, still "running", with
  // its own facebook_scan_jobs-backed group breakdown. Before the fix,
  // Finder's page polled THIS scanRunId automatically on load/refresh.
  lastScan: { id: "scan-row-1", scanRunId: watcherRunId, searchFilterId: filterId, source: "facebook", status: "running", startedAt: now, finishedAt: null, scannedCount: 110, matchedCount: 12, listingsCreated: 3, newCount: 3, listingsUpdated: 2, priceDropCount: 0 },
};

const listPayload = {
  filters: [filter],
  latestScan: null,
  summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 0, activeListings: 0, removedListings: 0, newMatches: 0 },
};

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

// The Watcher-leak payload: real Facebook group names, a full per-group
// breakdown, and the exact live-production COLLECTOR_NOT_AVAILABLE error
// text -- deliberately shaped exactly like what a genuine Watcher-owned
// scan_run_id's progress response would contain.
function watcherLeakProgress(runId) {
  return {
    runId,
    status: "running",
    startedAt: now,
    finishedAt: null,
    elapsedMs: 2_953_000,
    overall: { completedUnits: 7, totalUnits: 8, percent: 87, failedUnits: 0, remainingUnits: 1 },
    current: { source: "facebook", groupName: "Dawid Trojanowski" },
    facebook: {
      totalGroups: 8,
      completedGroups: 5,
      runningGroups: 1,
      queuedGroups: 2,
      failedGroups: 0,
      discovered: 110,
      processed: 110,
      groups: [
        { groupId: "1", groupName: "Łódź Mieszkania Sprzedaż", status: "completed", discovered: 20, processed: 20, sourceScanId: "s1", errorMessage: null },
        { groupId: "2", groupName: "Dawid Trojanowski", status: "running", discovered: 15, processed: 12, sourceScanId: "s2", errorMessage: null },
        { groupId: "3", groupName: "Nieruchomości Łódzkie", status: "queued", discovered: 0, processed: 0, sourceScanId: "s3", errorMessage: null },
      ],
    },
    olx: { status: null, raw: 0, normalized: 0, processed: 0, errorMessage: null },
    totals: { scanned: 110, matched: 12, created: 3, updated: 2, priceDrops: 0 },
    collector: null,
    partialReason: null,
    errors: ["COLLECTOR_NOT_AVAILABLE: Facebook Collector did not claim the queued job within 90 seconds"],
    openai: emptyOpenai,
  };
}

function financeCompletedProgress(runId) {
  return {
    runId,
    status: "completed",
    startedAt: now,
    finishedAt: now,
    elapsedMs: 1_200,
    overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 0, remainingUnits: 0 },
    current: null,
    facebook: { totalGroups: 0, completedGroups: 0, runningGroups: 0, queuedGroups: 0, failedGroups: 0, discovered: 0, processed: 0, groups: [] },
    olx: { status: null, raw: 0, normalized: 0, processed: 0, errorMessage: null },
    totals: { scanned: 4, matched: 1, created: 0, updated: 1, priceDrops: 0 },
    collector: null,
    partialReason: null,
    errors: [],
    openai: emptyOpenai,
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

test("real Finder page never renders Watcher group data or COLLECTOR_NOT_AVAILABLE, on load or after clicking Skanuj", { timeout: 600_000 }, async (t) => {
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

  const facebookRequests = [];

  const page = await browser.newPage();
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  page.on("request", (request) => {
    if (/facebook\.com/i.test(request.url())) facebookRequests.push(request.url());
  });
  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listPayload), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(resultsPayload), status: 200 });
    }
    // If a leaked-poll bug ever reintroduced polling of the filter's own
    // (Watcher-owned) lastScan.runId, this is the exact URL it would hit.
    if (url.pathname === `/api/flip-finder/scans/${watcherRunId}`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(watcherLeakProgress(watcherRunId)), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/scan` && request.method() === "POST") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ runId: financeRunId, status: "completed", scannedCount: 4, matchedCount: 1, newCount: 0, updatedCount: 1, priceDropCount: 0 }), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/scans/${financeRunId}`) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(financeCompletedProgress(financeRunId)), status: 200 });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });

  await t.test("on load, with no click at all, the page shows nothing from the Watcher-owned lastScan", async () => {
    await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
    await page.getByText(filter.name).first().waitFor({ state: "visible", timeout: 60_000 });
    // Give any stray polling effect a real chance to fire before asserting absence.
    await page.waitForTimeout(2_000);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Dawid Trojanowski/, "a Watcher-owned group/person name must never appear on page load with zero clicks");
    assert.doesNotMatch(bodyText, /Łódź Mieszkania Sprzedaż|Nieruchomości Łódzkie/, "no per-group Watcher breakdown may appear on page load");
    assert.doesNotMatch(bodyText, /COLLECTOR_NOT_AVAILABLE/, "the Watcher's collector-timeout error must never appear on page load");
    assert.equal(facebookRequests.length, 0, "the page must never issue a request to facebook.com on load");
  });

  await t.test("after clicking Skanuj, only Finder's own completed recalculation is shown -- still no Watcher group data", async () => {
    const scanButton = page.getByRole("button", { name: /Skanuj/i }).first();
    await scanButton.click();
    await page.waitForTimeout(1_500);
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Dawid Trojanowski/, "clicking Skanuj must never surface a Watcher group/person name");
    assert.doesNotMatch(bodyText, /Łódź Mieszkania Sprzedaż|Nieruchomości Łódzkie/, "clicking Skanuj must never surface a per-group Watcher breakdown");
    assert.doesNotMatch(bodyText, /COLLECTOR_NOT_AVAILABLE/, "clicking Skanuj must never surface the Watcher's collector-timeout error");
    assert.equal(facebookRequests.length, 0, "clicking Skanuj must never cause a request to facebook.com");
  });
});
