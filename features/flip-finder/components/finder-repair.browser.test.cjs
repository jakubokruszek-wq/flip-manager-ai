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
 * Real-browser proof of the Finder repair (2026-10-13), against a production
 * build with the Finder API mocked locally (no Production access):
 * - a failing results API shows the real error and a retry, not an empty Finder;
 * - all persisted matches render, older ones flagged instead of hidden;
 * - Dopasowane / Do oceny / Do weryfikacji budynku / Archiwalne counters;
 * - excluded current memberships are listed with their reason;
 * - the archive is requested only after it is opened, one page at a time;
 * - an operator building confirmation moves an offer back to Dopasowane.
 */

const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-13T10:00:00.000Z";
const filter = {
  id: filterId, name: "Flip", sources: ["otodom", "olx"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: 31, areaMax: 75,
  rooms: [1, 2, 3, 4], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"],
  ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 6500, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null,
  createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

const card = (id, overrides = {}) => ({
  id, source: "olx", title: `Mieszkanie ${id}`, price: 269_000, area: 47.19, rooms: 2, floor: "2", totalFloors: null, buildingType: "blok",
  ownership: null, description: "Mieszkanie w bloku.", images: [], pricePerSqm: 5_700, locationText: "Śródmieście, Łódź", address: null, city: "Łódź",
  district: "Śródmieście", thumbnailUrl: null, originalUrl: `https://www.olx.pl/d/oferta/${id}.html`, listingStatus: "active", isActive: true,
  publishedAt: "2026-10-01T21:57:40.000Z", publicationAgeDays: 11, isOlderListing: false, lastVerifiedDaysAgo: 0, verificationStale: false,
  firstSeenAt: "2026-10-02T08:00:00.000Z", lastSeenAt: "2026-10-13T08:00:00.000Z", firstMatchedAt: "2026-10-02T08:00:00.000Z", lastMatchedAt: "2026-10-13T08:00:00.000Z",
  previousPrice: null, currentPrice: 269_000, isNew: false, hasPriceDrop: false, priceDropAmount: null, matchReasons: [], unknownFields: [],
  decisionBucket: "MATCHED", lifecycleStatus: "ACTIVE", missingFields: [], manualDecision: null, galleryStatus: "NOT_REQUESTED", flipScore: 60,
  estimatedProfit: 40_000, estimatedRoi: 12, crossSourceIdentity: null, finderSection: "MATCHED",
  buildingQualification: { status: "confirmed", type: "blok", reason: "building_type_confirmed_structured", source: "structured" },
  linkedListings: [{ id, source: "olx", title: `Mieszkanie ${id}`, price: 269_000, area: 47.19, rooms: 2, originalUrl: `https://www.olx.pl/d/oferta/${id}.html` }],
  ...overrides,
});

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

async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
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

test("Finder browser: real errors, visible older matches, separate building queue, explained exclusions and a lazy archive", { timeout: 600_000 }, async (t) => {
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "finder-repair-browser-test-key",
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

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await addOperatorSessionCookie(page.context(), baseUrl);

  let failNextResults = true;
  let confirmed = false;
  const requests = [];
  const confirmations = [];
  const payload = () => {
    const results = [
      card("srodmiescie-269"),
      card("teofilow-238", { price: 238_000, area: 37.07, district: "Teofilów", publishedAt: "2026-05-29T19:56:11.000Z", publicationAgeDays: 136, isOlderListing: true, lastVerifiedDaysAgo: 5, verificationStale: true }),
      ...(confirmed ? [card("unknown-building", { buildingQualification: { status: "confirmed", type: "blok", reason: "building_type_confirmed_operator", source: "operator" } })] : []),
    ];
    const buildingVerificationResults = confirmed ? [] : [card("unknown-building", {
      decisionBucket: "REVIEW", finderSection: "BUILDING_VERIFICATION", lifecycleStatus: "REVIEW", unknownFields: ["buildingType"], missingFields: ["buildingType"], buildingType: null,
      buildingQualification: { status: "needs_verification", type: null, reason: "building_type_unknown", source: null },
    })];
    const reviewResults = [card("review-rooms", { decisionBucket: "REVIEW", finderSection: "REVIEW", lifecycleStatus: "REVIEW", rooms: null, unknownFields: ["rooms"], missingFields: ["rooms"] })];
    return {
      filter, results, reviewResults, buildingVerificationResults,
      excludedResults: [{ id: "tenement", title: "Mieszkanie w kamienicy", price: 250_000, area: 50, district: "Śródmieście", source: "olx", originalUrl: "https://www.olx.pl/d/oferta/tenement.html", publishedAt: null, lastSeenAt: now, lifecycleStatus: "ACTIVE", isCurrentMatch: true, code: "filter_rejected", reasons: ["building_type"], label: "Typ budynku „kamienica” nie pasuje do filtra (blok/apartamentowiec)" }],
      archivedResults: [], archive: null,
      counts: { active: results.length, review: 1, buildingVerification: buildingVerificationResults.length, excluded: 1, archived: 3763 },
      total: results.length, newMatches: 0, lastScan: null, sourceScans: [],
      identityFeatures: { automaticEvidenceAvailable: true, manualReviewAvailable: true, buildingConfirmationAvailable: true },
      diagnostics: { view: "active", queryCount: 9, membershipRowsRead: 92, listingRowsRead: 92, snapshotRowsRead: 4, sourceScanRowsRead: 12, durationMs: 140 },
    };
  };
  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, view: url.searchParams.get("view"), offset: url.searchParams.get("offset"), method: request.method() });
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: [{ ...filter, totalMatches: 4, visibleCounts: { matched: 2, review: 1, buildingVerification: 1, excluded: 1 }, countsError: null, newMatches: 0, lastScan: null }], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 3854, activeListings: 4, removedListings: 0, newMatches: 0 } }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results` && url.searchParams.get("view") === "archive") {
      const offset = Number(url.searchParams.get("offset"));
      const archivedResults = Array.from({ length: 30 }, (_, index) => card(`archived-${offset + index}`, { lifecycleStatus: "ARCHIVED", decisionBucket: "REJECTED", finderSection: undefined }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...payload(), results: [], reviewResults: [], buildingVerificationResults: [], excludedResults: [], archivedResults, archive: { offset, limit: 30, total: 3763, hasMore: offset + 30 < 3763 } }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      if (failNextResults) {
        failNextResults = false;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Nie udało się pobrać wyników filtra.", detail: "Nie udało się pobrać ofert dla filtra.", code: "FINDER_RESULTS_READ_FAILED" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload()) });
    }
    if (url.pathname === "/api/flip-finder/listings/unknown-building/building-type" && request.method() === "POST") {
      confirmations.push(request.postDataJSON());
      confirmed = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, listingId: "unknown-building", buildingType: "blok" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const errorPanel = page.getByTestId("finder-load-error");
  await errorPanel.waitFor({ state: "visible", timeout: 60_000 });
  assert.match(await errorPanel.innerText(), /HTTP 500/);
  assert.match(await errorPanel.innerText(), /Nie udało się pobrać ofert dla filtra/);
  assert.equal(await page.getByText("Brak dopasowanych ofert dla tego filtra.").count(), 0, "an API failure is never presented as an empty Finder");

  await errorPanel.getByRole("button", { name: "Spróbuj ponownie" }).click();
  await page.getByTestId("finder-card").first().waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await page.getByTestId("finder-load-error").count(), 0);
  const counts = await page.getByTestId("finder-section-counts").innerText();
  assert.match(counts, /Dopasowane: 2 · Do oceny: 1 · Do weryfikacji budynku: 1 · Archiwalne: 3763/);
  assert.match(counts, /Wykluczone z powodem: 1/);
  assert.equal(await page.getByTestId("finder-card-older").count(), 1, "the 136-day-old match is shown with an 'older' badge");
  assert.equal(await page.getByTestId("finder-card-unconfirmed").count(), 1);
  assert.equal(requests.filter((request) => request.view === "archive").length, 0, "the archive is never fetched before it is opened");

  await page.getByTestId("finder-excluded").locator("summary").click();
  assert.match(await page.getByTestId("finder-excluded-item").first().innerText(), /kamienica/u);

  await page.getByTestId("finder-building-verification").locator("summary").click();
  const confirmation = page.getByTestId("finder-building-confirmation").first();
  await confirmation.getByRole("button", { name: "Blok" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="finder-building-verification"]').length === 0);
  assert.deepEqual(confirmations, [{ buildingType: "blok" }]);
  assert.match(await page.getByTestId("finder-section-counts").innerText(), /Dopasowane: 3 · Do oceny: 1 · Do weryfikacji budynku: 0/);

  await page.getByRole("button", { name: "Otwórz historię ofert" }).click();
  await page.getByTestId("finder-archive").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Pokaż kolejne archiwalne oferty" }).waitFor({ state: "visible", timeout: 20_000 });
  assert.deepEqual(requests.filter((request) => request.view === "archive").map((request) => request.offset), ["0"]);
  await page.getByRole("button", { name: "Pokaż kolejne archiwalne oferty" }).click();
  await page.waitForFunction(() => /Wczytano 60 z 3763/.test(document.querySelector('[data-testid="finder-archive"]')?.textContent ?? ""));
  assert.deepEqual(requests.filter((request) => request.view === "archive").map((request) => request.offset), ["0", "30"], "the archive is paged on the server");

  await page.getByTestId("finder-age-filter").first().selectOption("older").catch(async () => page.locator('select[aria-label="Wiek ogłoszenia"]').nth(1).selectOption("older"));
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `page does not overflow horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
  }
});
