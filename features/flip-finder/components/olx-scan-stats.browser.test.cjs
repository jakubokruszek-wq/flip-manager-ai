/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require("../../test-support/browser-auth.cjs");

/**
 * Real-browser proof for PR #13: after the OLX job of a run is completed
 * asynchronously (Cloudflare stage-2 worker), the Finder page receives the
 * result only through GET /api/flip-finder/scans/:runId. The OLX source card
 * under "Diagnoza odrzuceń" must show the stored stats: read, unique,
 * duplicates, new, updated, matched, review and rejected by the filter.
 * The progress payload below has exactly the shape getScanProgress returns
 * (olx.stats / olx.warnings, see olx-stats-ui-flow.test.ts for the server half).
 */

const filterId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-13T20:07:00.000Z";
const filter = {
  id: filterId, name: "Flip OLX", sources: ["olx"], city: "Łódź", districts: [], priceMin: null, priceMax: 300000, areaMin: 25, areaMax: null,
  rooms: [2, 3], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok"], ownershipTypes: [],
  marketType: null, privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null,
  maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: now, updatedAt: now, totalMatches: 0, newMatches: 0, lastScan: null,
};
const emptyOpenai = { lastRun: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" }, today: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" }, month: { costUsd: 0, calls: 0, totalTokens: 0, dataQuality: "EXACT" }, monthlyBudgetUsd: null, remainingBudgetUsd: null, budgetUsedPercent: null, balanceUsd: null, balanceStatus: "UNAVAILABLE" };
const stats = { read: 52, skippedInvalid: 0, unique: 49, duplicates: 3, created: 4, updated: 3, unchanged: 42, matched: 1, review: 2, rejectedByFilter: 46 };
const completedProgress = {
  runId, status: "completed", startedAt: "2026-10-13T07:30:00.000Z", finishedAt: now, elapsedMs: 1_000,
  overall: { completedUnits: 1, totalUnits: 1, percent: 100, failedUnits: 0, remainingUnits: 0 },
  current: null,
  facebook: { totalGroups: 0, completedGroups: 0, runningGroups: 0, queuedGroups: 0, failedGroups: 0, discovered: 0, processed: 0, groups: [] },
  olx: { status: "completed", raw: 52, normalized: 52, processed: 52, errorMessage: null, stats, warnings: ["OLX_DUPLICATE_LISTINGS_MERGED: 3 powtórzeń tej samej oferty przetworzono raz."] },
  totals: { scanned: 52, matched: 1, created: 4, updated: 3, priceDrops: 3 },
  collector: null, partialReason: null, errors: [], openai: emptyOpenai,
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => (error ? reject(error) : resolve(port))); });
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve((response.statusCode ?? 500) < 500); });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready within 60 seconds");
}

test("the OLX source card shows the stats of an asynchronously completed OLX job", { timeout: 600_000 }, async (t) => {
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "olx-stats-browser-test-key",
    SUPABASE_URL: auth.url, SUPABASE_SERVICE_ROLE_KEY: "local-ui-only",
  };
  await ensureProductionBuild(nextBin, root, env);
  const port = await freePort();
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
  server.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-4_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForServer(`${baseUrl}/flip-finder`); } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}; ${serverOutput}`); }
  // Optional local override when the installed browser build differs from the pinned Playwright one.
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await addOperatorSessionCookie(page.context(), baseUrl);

  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/latest-run")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: null }) });
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 0, activeListings: 0, removedListings: 0, newMatches: 0 } }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filter, results: [], reviewResults: [], archivedResults: [], counts: { active: 0, review: 0, archived: 0 }, total: 0, newMatches: 0, lastScan: null, sourceScans: [] }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/scan` && request.method() === "POST") {
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runId, status: "running", background: true, scannedCount: 0, matchedCount: 0, newCount: 0, updatedCount: 0, priceDropCount: 0 }) });
    }
    if (url.pathname === `/api/flip-finder/scans/${runId}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completedProgress) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const scanButton = page.getByRole("button", { name: /Skanuj oferty|Skanowanie…|Skanuj teraz/i }).first();
  await scanButton.waitFor({ state: "visible", timeout: 60_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nPage text: ${(await page.locator("body").innerText()).slice(0, 1_500)}`);
  });
  await scanButton.click();
  const diagnosis = page.getByRole("button", { name: "Diagnoza odrzuceń" }).first();
  await diagnosis.waitFor({ state: "visible", timeout: 30_000 });
  await diagnosis.click();
  await page.getByText("Ocena filtra").first().waitFor({ state: "visible", timeout: 15_000 });

  const card = page.locator("div.rounded-xl", { has: page.getByText("Dane źródłowe") }).last();
  const text = (await card.innerText()).replace(/\s+/g, " ");
  assert.match(text, /OLX/);
  for (const [label, value] of [["Odczytane", 52], ["Unikalne", 49], ["Powtórzenia", 3], ["Nowe rekordy", 4], ["Zaktualizowane", 3], ["Dopasowane", 1], ["Do weryfikacji", 2], ["Odrzucone przez filtr", 46]]) {
    assert.match(text, new RegExp(`${label} ${value}(?!\\d)`), `${label} ${value} visible in the OLX card: ${text}`);
  }
  assert.match(text, /OLX_DUPLICATE_LISTINGS_MERGED/);
});
