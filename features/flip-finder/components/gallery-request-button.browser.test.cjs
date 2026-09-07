/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const listingId = "db82d135-62ea-468f-a264-acdc0d138129";
const postId = "1749121366325600";
const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-06T12:00:00.000Z";

const filter = {
  id: filterId,
  name: "Browser gallery test",
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
  lastScan: null,
};

const result = {
  id: listingId,
  title: "Real Facebook review fixture",
  description: "Mieszkanie do oceny",
  price: 300_000,
  area: 44,
  rooms: 2,
  floor: "2",
  totalFloors: "4",
  buildingType: null,
  ownership: null,
  images: [],
  pricePerSqm: 6818,
  locationText: "Łódź",
  address: null,
  city: "Łódź",
  district: null,
  thumbnailUrl: null,
  originalUrl: `https://www.facebook.com/groups/example/permalink/${postId}/`,
  source: "facebook",
  listingStatus: "active",
  isActive: true,
  firstSeenAt: now,
  lastSeenAt: now,
  firstMatchedAt: now,
  lastMatchedAt: now,
  previousPrice: null,
  currentPrice: 300_000,
  isNew: false,
  hasPriceDrop: false,
  priceDropAmount: null,
  matchReasons: [],
  unknownFields: ["buildingType"],
  decisionBucket: "REVIEW",
  lifecycleStatus: "REVIEW",
  reviewReason: "BUILDING_UNVERIFIED",
  missingFields: ["buildingType"],
  manualDecision: null,
  galleryStatus: "NOT_REQUESTED",
  galleryJobId: null,
  galleryTotal: 0,
  galleryPersistedCount: 0,
  galleryError: null,
};

const listPayload = {
  filters: [filter],
  latestScan: null,
  summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 1, activeListings: 0, removedListings: 0, newMatches: 0 },
};

const resultsPayload = {
  filter,
  results: [],
  reviewResults: [result],
  archivedResults: [],
  counts: { active: 0, review: 1, archived: 0 },
  total: 0,
  newMatches: 0,
  lastScan: null,
  sourceScans: [],
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
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

async function preparePage(browser, baseUrl, { throwTraceFetch = false, initialGalleryStatus = result.galleryStatus, galleryStatusResponse = null } = {}) {
  const page = await browser.newPage();
  const traceRequests = [];
  let galleryRequests = 0;
  if (throwTraceFetch) {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/gallery/trace")) throw new Error("SYNCHRONOUS_TRACE_FETCH_FAILURE");
        return realFetch(input, init);
      };
    });
  }
  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/gallery/trace")) {
      traceRequests.push(JSON.parse(request.postData() || "{}"));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/listings/${listingId}/gallery` && request.method() === "GET") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, status: galleryStatusResponse ?? initialGalleryStatus, total: 0, persistedCount: 0 }), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/listings/${listingId}/gallery` && request.method() === "POST") {
      galleryRequests += 1;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, status: "PENDING", jobId: "22222222-2222-4222-8222-222222222222" }), status: 202 });
    }
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listPayload), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      const payload = initialGalleryStatus === result.galleryStatus ? resultsPayload : { ...resultsPayload, reviewResults: [{ ...result, galleryStatus: initialGalleryStatus }] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload), status: 200 });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });
  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const button = page.locator(`[data-gallery-request-button="true"][data-listing-id="${listingId}"]`);
  await button.waitFor({ state: "visible", timeout: 20_000 });
  return { page, button, traceRequests, galleryRequestCount: () => galleryRequests };
}

async function sessionStages(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("flipFinderGalleryRequestTraces") || "[]").map((entry) => entry.stage));
}

test("real Flip Finder gallery button keeps business click independent from trace and rerenders", { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/flip-finder`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test("pointer, native capture, React handler, guard and fetch run exactly once", async () => {
    const testPage = await preparePage(browser, baseUrl);
    await testPage.button.click();
    await assert.doesNotReject(() => testPage.page.waitForFunction(() => JSON.parse(sessionStorage.getItem("flipFinderGalleryRequestTraces") || "[]").some((entry) => entry.stage === "GALLERY_FETCH_RESPONSE"), null, { timeout: 10_000 }));
    const stages = await sessionStages(testPage.page);
    for (const stage of ["GALLERY_BUTTON_RENDERED", "GALLERY_NATIVE_POINTER_CAPTURE", "GALLERY_NATIVE_CLICK_CAPTURE", "GALLERY_BUTTON_POINTER_CAPTURE", "GALLERY_BUTTON_CLICK_CAPTURE", "GALLERY_UI_CLICK", "GALLERY_HANDLER_ENTER", "GALLERY_GUARD_PASS", "GALLERY_FETCH_START", "GALLERY_FETCH_RESPONSE"]) {
      assert.equal(stages.filter((value) => value === stage).length, 1, `${stage} should occur once; server output: ${output}`);
    }
    assert.equal(testPage.galleryRequestCount(), 1);
    await testPage.page.close();
  });

  await t.test("a synchronous trace fetch failure cannot block the gallery POST", async () => {
    const testPage = await preparePage(browser, baseUrl, { throwTraceFetch: true });
    await testPage.button.click();
    await testPage.page.waitForFunction(() => JSON.parse(sessionStorage.getItem("flipFinderGalleryRequestTraces") || "[]").some((entry) => entry.stage === "GALLERY_FETCH_RESPONSE"), null, { timeout: 10_000 });
    assert.equal(testPage.galleryRequestCount(), 1, `gallery POST should survive trace failure; server output: ${output}`);
    const stages = await sessionStages(testPage.page);
    assert.equal(stages.filter((value) => value === "GALLERY_HANDLER_ENTER").length, 1);
    assert.equal(stages.filter((value) => value === "GALLERY_FETCH_START").length, 1);
    await testPage.page.close();
  });

  await t.test("a results rerender between pointerdown and click keeps the button actionable", async () => {
    const testPage = await preparePage(browser, baseUrl);
    await testPage.button.dispatchEvent("pointerdown", { bubbles: true, pointerType: "mouse" });
    await testPage.page.getByLabel("Sortowanie").selectOption("newest");
    await testPage.button.dispatchEvent("pointerup", { bubbles: true, pointerType: "mouse" });
    await testPage.button.dispatchEvent("click", { bubbles: true });
    await testPage.page.waitForFunction(() => JSON.parse(sessionStorage.getItem("flipFinderGalleryRequestTraces") || "[]").some((entry) => entry.stage === "GALLERY_FETCH_RESPONSE"), null, { timeout: 10_000 });
    assert.equal(testPage.galleryRequestCount(), 1, `rerendered gallery button should POST once; server output: ${output}`);
    const traces = await testPage.page.evaluate(() => JSON.parse(sessionStorage.getItem("flipFinderGalleryRequestTraces") || "[]"));
    const mount = traces.find((entry) => entry.stage === "GALLERY_BUTTON_MOUNT");
    const click = traces.find((entry) => entry.stage === "GALLERY_UI_CLICK");
    assert.ok(mount?.instanceId);
    assert.equal(click?.instanceId, mount.instanceId);
    await testPage.page.close();
  });

  await t.test("a stale pending status is refreshed to terminal failure and enables retry", async () => {
    const testPage = await preparePage(browser, baseUrl, { initialGalleryStatus: "PENDING", galleryStatusResponse: "FAILED" });
    await testPage.page.waitForFunction(() => document.querySelector('[data-gallery-request-button="true"]')?.dataset.galleryStatus === "FAILED", null, { timeout: 10_000 });
    assert.equal(await testPage.button.isEnabled(), true);
    await testPage.page.close();
  });
});
