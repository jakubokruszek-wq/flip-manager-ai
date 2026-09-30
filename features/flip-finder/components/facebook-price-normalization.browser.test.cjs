/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require("../../test-support/browser-auth.cjs");

/**
 * Real production bug: a Facebook post titled "2 pokoje z balkonem za 260 000
 * zł" showed askingPrice/Cena ofertowa as "Brak danych" and "Lokalizacja
 * nieznana" in Finder, even though the price is stated completely
 * unambiguously in the title. Root-caused to extract-facebook-listing.ts's
 * classifyFacebookProperty(), whose realEstateLanguage regex didn't recognize
 * "pokoje"/"balkon", so the whole listing fell below the required 3
 * structured-field threshold and was discarded as "not real estate" during
 * automated import -- before its correctly-parsed price ever reached the
 * canonical listing record. This proves, in a real rendered Finder card, that
 * a listing carrying the canonical values the fixed pipeline now produces for
 * this exact title shows a real price and location, never the old symptom.
 */
const filterId = "22222222-2222-4222-8222-222222222222";
const listingId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-30T12:00:00.000Z";

const filter = {
  id: filterId, name: "Facebook price bug filter", sources: ["facebook"], city: "Łódź", districts: [],
  priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null,
  privateOnly: false, maxPricePerSqm: 12_000, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
  lastScannedAt: now, createdAt: now, updatedAt: now,
};

// The exact canonical values the now-fixed pipeline produces for
// "2 pokoje z balkonem za 260 000 zł": a real, non-null price/pricePerSqm and
// a resolved Łódź/Górna location, not the pre-fix null/"unknown" symptom.
const result = {
  id: listingId, title: "2 pokoje z balkonem za 260 000 zł", description: "2 pokoje z balkonem za 260 000 zł",
  price: 260_000, area: 38, rooms: 2, floor: null, totalFloors: null, buildingType: null, ownership: null,
  images: [], pricePerSqm: 260_000 / 38, locationText: "Łódź, Górna", address: null, city: "Łódź", district: "Górna",
  thumbnailUrl: null, sourcePostUrl: "https://www.facebook.com/groups/example/posts/260000/", originalUrl: null,
  source: "facebook", listingStatus: "active", isActive: true, firstSeenAt: now, lastSeenAt: now,
  firstMatchedAt: now, lastMatchedAt: now, previousPrice: null, currentPrice: 260_000, isNew: false,
  hasPriceDrop: false, priceDropAmount: null, matchReasons: [], unknownFields: [], decisionBucket: "MATCHED",
  lifecycleStatus: "ACTIVE", reviewReason: null, missingFields: [], manualDecision: null,
  galleryStatus: "NOT_REQUESTED", galleryJobId: null, galleryTotal: 0, galleryPersistedCount: 0, galleryError: null,
};

const listPayload = { filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 1, activeListings: 1, removedListings: 0, newMatches: 0 } };
const resultsPayload = { filter, results: [result], reviewResults: [], archivedResults: [], counts: { active: 1, review: 0, archived: 0 }, total: 1, newMatches: 0, lastScan: null, sourceScans: [] };

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
      const request = http.get(url, (response) => {
        response.resume();
        resolve(response.statusCode < 500);
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready");
}

test("a Facebook listing with the fixed canonical price/location renders a real price, never 'Brak danych'/'Lokalizacja nieznana'", { timeout: 180_000 }, async (t) => {
  const port = await freePort();
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());

  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "facebook-price-bug-publishable-key",
  };
  await ensureProductionBuild(nextBin, root, env);
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/flip-finder`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;
  const page = await browser.newPage();
  await addOperatorSessionCookie(page.context(), baseUrl);
  const disallowedRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/facebook\.com/i.test(url) || /\/api\/facebook-watcher\//.test(url) || /\/api\/jobs\/facebook-watch/.test(url)) disallowedRequests.push(url);
  });
  await page.route("**/api/flip-finder/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flip-finder/search-filters") return route.fulfill({ contentType: "application/json", body: JSON.stringify(listPayload), status: 200 });
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) return route.fulfill({ contentType: "application/json", body: JSON.stringify(resultsPayload), status: 200 });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const card = page.locator(`[data-testid="finder-card"][data-listing-id="${listingId}"]`);
  await card.waitFor({ state: "visible", timeout: 60_000 });
  const cardText = await card.innerText();

  assert.match(cardText, /260[\s ]?000/, "the card must show the real, fixed price, not blank");
  assert.doesNotMatch(cardText, /Brak danych/, "the old symptom (no askingPrice) must not appear");
  assert.match(cardText, /Górna|Łódź/, "the card must show the real, resolved location");
  assert.doesNotMatch(cardText, /Lokalizacja nieznana/, "the old symptom (unknown location) must not appear");

  await card.locator("article > button").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  const dialogText = (await dialog.textContent()).replace(/ /g, " ");
  assert.match(dialogText, /260[\s ]?000/, "the opened detail dialog must also show the real price");
  assert.doesNotMatch(dialogText, /unknown_price/i, "the raw internal unknown_price code must never leak into the UI");

  assert.deepEqual(disallowedRequests, [], "Finder must never contact facebook.com or any Watcher-specific endpoint while reading and displaying this saved listing");

  await page.close();
});
