/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require("../../test-support/browser-auth.cjs");

const filterId = "11111111-1111-4111-8111-111111111111";
const listingA = "22222222-2222-4222-8222-222222222222";
const listingB = "33333333-3333-4333-8333-333333333333";
const sourceUrlA = "https://gratka.pl/nieruchomosci/oferta/gr-a";
const sourceUrlB = "https://morizon.pl/oferta/mr-b";

const filter = {
  id: filterId,
  name: "Identity UI fixture",
  sources: ["gratka", "morizon"],
  city: "Lodz",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 30,
  areaMax: 80,
  rooms: [2],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: ["kamienica"],
  ownershipTypes: [],
  marketType: "secondary",
  privateOnly: false,
  maxPricePerSqm: 14_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 30,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const listing = (id, source, originalUrl, overrides = {}) => ({
  id,
  source,
  title: "Dwupokojowe mieszkanie Tuwima 12/4",
  price: source === "gratka" ? 365_000 : 389_000,
  area: 50.2,
  rooms: 2,
  floor: "3",
  totalFloors: 4,
  buildingType: "kamienica",
  ownership: "full_ownership",
  description: "Fixture mieszkania do lokalnego testu UI.",
  images: [],
  pricePerSqm: 7_270,
  locationText: "Centrum, Lodz",
  address: "Tuwima 12/4",
  city: "Lodz",
  district: "Centrum",
  thumbnailUrl: null,
  originalUrl,
  listingStatus: "active",
  isActive: true,
  firstSeenAt: "2026-10-01T00:00:00.000Z",
  lastSeenAt: "2026-10-08T12:00:00.000Z",
  firstMatchedAt: "2026-10-08T12:00:00.000Z",
  lastMatchedAt: "2026-10-08T12:00:00.000Z",
  previousPrice: null,
  currentPrice: source === "gratka" ? 365_000 : 389_000,
  isNew: false,
  hasPriceDrop: false,
  priceDropAmount: null,
  matchReasons: [],
  unknownFields: [],
  decisionBucket: "MATCHED",
  lifecycleStatus: "ACTIVE",
  missingFields: [],
  manualDecision: null,
  galleryStatus: "NOT_REQUESTED",
  flipScore: 50,
  estimatedProfit: 40_000,
  estimatedRoi: 10,
  crossSourceIdentity: null,
  linkedListings: [{ id, source, title: "Dwupokojowe mieszkanie Tuwima 12/4", price: source === "gratka" ? 365_000 : 389_000, area: 50.2, rooms: 2, originalUrl, publishedAt: "2026-10-06T12:00:00.000Z", firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-08T12:00:00.000Z" }],
  ...overrides,
});

const candidateA = listing(listingA, "gratka", sourceUrlA, {
  identityCandidates: [{ id: listingB, source: "morizon", title: "Dwupokojowe mieszkanie Tuwima 12/4", price: 389_000, area: 50.2, rooms: 2, originalUrl: sourceUrlB, reason: "same_building_photos_and_parameters" }],
});
const candidateB = listing(listingB, "morizon", sourceUrlB, {
  identityCandidates: [{ id: listingA, source: "gratka", title: "Dwupokojowe mieszkanie Tuwima 12/4", price: 365_000, area: 50.2, rooms: 2, originalUrl: sourceUrlA, reason: "same_building_photos_and_parameters" }],
});
const grouped = listing(listingA, "gratka", sourceUrlA, {
  identityGroupId: "44444444-4444-4444-8444-444444444444",
  linkedListings: [candidateA.linkedListings[0], candidateB.linkedListings[0]],
});
const automaticGroup = { ...grouped, identityGroupId: null };

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

test("Finder browser: candidate confirmation links one card, source links survive refresh, and unlink persists", { timeout: 600_000 }, async (t) => {
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "identity-browser-test-key",
    SUPABASE_URL: auth.url,
    SUPABASE_SERVICE_ROLE_KEY: "local-ui-only",
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
  await addOperatorSessionCookie(page.context(), baseUrl);

  let state = "automatic";
  const decisions = [];
  const requests = [];
  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 2, activeListings: 2, removedListings: 0, newMatches: 0 } }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      const rows = state === "automatic" ? [automaticGroup] : state === "candidate" ? [candidateA, candidateB] : state === "linked" ? [grouped] : [
        listing(listingA, "gratka", sourceUrlA, { identityCandidates: [] }),
        listing(listingB, "morizon", sourceUrlB, { identityCandidates: [] }),
      ];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filter, results: rows, reviewResults: [], archivedResults: [], counts: { active: rows.length, review: 0, archived: 0 }, total: rows.length, newMatches: 0, lastScan: null, sourceScans: [], identityFeatures: { automaticEvidenceAvailable: true, manualReviewAvailable: true } }) });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/identity` && request.method() === "POST") {
      const body = request.postDataJSON();
      decisions.push(body);
      if (body.action === "link") state = "linked";
      else if (body.action === "unlink") state = "not-linked";
      else if (body.action === "not_link") state = "not-linked";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: body.action }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  await page.getByText(filter.name, { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("finder-card").first().waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await page.getByTestId("finder-card").count(), 1, "automatically confirmed cross-portal identity renders one Finder card");
  await page.getByRole("button", { name: "Analizuj" }).click();
  assert.equal(await page.getByRole("link", { name: /Otw.rz Gratka/ }).getAttribute("href"), sourceUrlA);
  assert.equal(await page.getByRole("link", { name: /Otw.rz Morizon/ }).getAttribute("href"), sourceUrlB);
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(filter.name, { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("finder-card").first().waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await page.getByTestId("finder-card").count(), 1, "automatic grouping survives refresh according to the GET response");

  state = "candidate";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(filter.name, { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  try {
    await page.getByTestId("finder-card").first().waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    throw new Error(`Finder did not render fixture cards. requests=${JSON.stringify(requests)} errors=${JSON.stringify(pageErrors)} body=${(await page.locator("body").innerText()).slice(-5000)}`);
  }
  await page.getByRole("button", { name: "Analizuj" }).first().click();
  await page.getByRole("heading", { name: /Mo.*liwy duplikat/ }).waitFor({ state: "visible" });
  const candidateSection = page.getByRole("region", { name: "Możliwe duplikaty do weryfikacji" });
  await candidateSection.getByRole("link", { name: "Otwórz źródłową ofertę" }).waitFor({ state: "visible" });
  assert.equal(await candidateSection.getByRole("link", { name: "Otwórz źródłową ofertę" }).getAttribute("href"), sourceUrlB);
  page.on("dialog", (dialog) => dialog.accept());
  await candidateSection.getByRole("button", { name: /Po.*oferty/ }).click();
  await page.getByRole("heading", { name: /Znaleziono tak.*na/ }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("finder-card").count(), 1, "a successful manual decision changes two candidate cards into one property card");
  assert.equal(await page.getByRole("link", { name: /Otw.rz Gratka/ }).getAttribute("href"), sourceUrlA);
  assert.equal(await page.getByRole("link", { name: /Otw.rz Morizon/ }).getAttribute("href"), sourceUrlB);
  assert.deepEqual(decisions[0], { action: "link", listingA, listingB });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(filter.name, { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Analizuj" }).click();
  await page.getByRole("heading", { name: /Znaleziono tak.*na/ }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("finder-card").count(), 1, "the read response restores the single grouped card after refresh");

  for (const width of [320, 375, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth, `page does not overflow horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
  }

  await page.getByRole("button", { name: /Roz.*ofert. z grupy/ }).click();
  assert.deepEqual(decisions[1], { action: "unlink", listingA: listingB });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="finder-card"]').length === 2);
  assert.equal(await page.getByTestId("finder-card").count(), 2, "unlink preserves two source listings and separates their cards");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(filter.name, { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Analizuj" }).first().click();
  assert.equal(await page.getByRole("heading", { name: /Mo.*liwy duplikat/ }).count(), 0, "durable not_link suppresses the same candidate after refresh");
  assert.equal(requests.filter((request) => request.method !== "GET" && request.path.endsWith("/identity")).length, 2);
});
