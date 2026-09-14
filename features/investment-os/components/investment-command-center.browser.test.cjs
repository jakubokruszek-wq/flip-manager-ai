/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const listingId = "listing-finder-v3-fixture";
const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-12T10:00:00.000Z";

function fixtureResult() {
  return {
    id: listingId, title: "Łódź · 2 pokoje · 45 m²", description: "Fixture UI bez dostępu do Production.", price: 300_000, area: 45, rooms: 2,
    floor: "2", totalFloors: "4", buildingType: "blok", ownership: "pełna własność", images: [], pricePerSqm: 6_667,
    locationText: "Łódź · Górna", address: "Testowa 1, Łódź", city: "Łódź", district: "Górna", thumbnailUrl: null,
    originalUrl: "https://www.facebook.com/groups/1/posts/2", source: "facebook", listingStatus: "active", isActive: true,
    firstSeenAt: now, lastSeenAt: now, firstMatchedAt: now, lastMatchedAt: now, previousPrice: null, currentPrice: 300_000,
    isNew: false, hasPriceDrop: false, priceDropAmount: null, matchReasons: [], unknownFields: [], decisionBucket: "MATCHED",
    lifecycleStatus: "ACTIVE", reviewReason: null, missingFields: [], manualDecision: null, galleryStatus: "NOT_REQUESTED",
    galleryJobId: null, galleryTotal: 0, galleryPersistedCount: 0, galleryError: null,
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve((response.statusCode ?? 500) < 500); });
      request.setTimeout(1_000, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Lokalny Next dev server nie wystartował w 60 sekund.");
}

test("Finder prioritizes offers and keeps the modal as a quick preview with a canonical Deal Room route", { timeout: 180_000 }, async (t) => {
  const filter = {
    id: filterId, name: "Mieszkania w Łodzi", sources: ["facebook"], city: "Łódź", districts: [], priceMin: null, priceMax: null,
    areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false,
    buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 12_000, requiredKeywords: [], excludedKeywords: [],
    minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
    lastScannedAt: now, createdAt: now, updatedAt: now, totalMatches: 1, newMatches: 0, lastScan: null,
  };
  const result = fixtureResult();
  let resultsPayload = { filter, results: [result], reviewResults: [], archivedResults: [], counts: { active: 1, review: 0, archived: 0 }, total: 1, newMatches: 0, lastScan: null, sourceScans: [] };
  const root = path.resolve(__dirname, "../../..");
  const reviewDir = process.env.PREMIUM_UI_SCREENSHOT_DIR?.trim() || path.join(root, "artifacts", "flip-manager-v3-review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const port = await freePort();
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-ui-only", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "local-ui-only" },
    stdio: "ignore",
  });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/flip-finder`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const apiRequests = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/flip-finder/search-filters") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 1, activeListings: 1, removedListings: 0, newMatches: 0 } }) });
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resultsPayload) });
    if (url.pathname === "/api/import") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "Mieszkanie testowe w Łodzi", source: "otodom", originalUrl: "https://www.otodom.pl/pl/oferta/testowe", price: 315000, area: 48, rooms: 2, floor: "2", buildingType: "blok", ownership: "pełna własność", rent: 650, address: "Testowa 1", district: "Górna", city: "Łódź", description: "Lokalny fixture do przeglądu warstwy prezentacji.", images: [] }) });
    if (url.pathname === "/api/properties") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "property-ui-fixture", savedColumns: ["title", "price", "area"] }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  assert.ok(await page.getByRole("link", { name: "Pulpit" }).first().isVisible(), "the shared navigation title must be localized");
  const listingCard = page.getByRole("button", { name: /Łódź · 2 pokoje · 45 m²/ }).first();
  await listingCard.waitFor({ state: "visible", timeout: 20_000 });
  const filterSettings = page.locator("details").filter({ hasText: "Ustawienia filtra" }).first();
  assert.equal(await filterSettings.evaluate((element) => element.open), false, "filter settings should not precede the offers by default");
  assert.equal(await page.evaluate(() => { const offers = document.querySelector("[data-finder-offers]"); const sources = [...document.querySelectorAll("details")].find((element) => element.textContent?.includes("Źródła i historia skanów")); return Boolean(offers && sources && (offers.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING)); }), true, "offer cards must precede configuration and scan-history controls");
  const listingCardShell = listingCard.locator("xpath=..");
  const cardTop = await listingCardShell.evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(cardTop < 900, `first offer should be visible without scrolling past filter configuration (${cardTop}px)`);
  const dealRoomCta = page.getByRole("link", { name: "Otwórz Deal Room" }).first();
  await dealRoomCta.waitFor({ state: "visible" });
  const ctaBounds = await dealRoomCta.evaluate((element) => element.getBoundingClientRect().toJSON());
  assert.ok(ctaBounds.top >= cardTop && ctaBounds.bottom <= 900, `primary Deal Room CTA should be visible with the first offer (${JSON.stringify({ cardTop, ctaBounds })})`);
  const askingPrice = page.getByText(/300\s?000\s*zł/).first();
  await askingPrice.waitFor({ state: "visible" });
  const priceBounds = await askingPrice.evaluate((element) => element.getBoundingClientRect().toJSON());
  assert.ok(priceBounds.top < 900 && priceBounds.bottom <= 900, `first offer price should remain visible in the initial viewport (${JSON.stringify(priceBounds)})`);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: path.join(reviewDir, "06-finder-v3.png"), fullPage: false });

  await listingCard.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  assert.ok(await dialog.getByRole("link", { name: "Otwórz Deal Room" }).isVisible());
  await dialog.getByRole("tab", { name: "Szybki podgląd" }).click();
  await dialog.getByRole("heading", { name: "Najważniejsze liczby oferty" }).waitFor({ state: "visible" });
  assert.ok(await dialog.getByText("Maks. cena zakupu", { exact: true }).isVisible());
  assert.equal(await dialog.getByText("Zespół analityczny", { exact: true }).count(), 0, "the modal must not duplicate the Director Council");
  assert.equal(await dialog.getByText("Oś czasu analizy", { exact: true }).count(), 0, "the modal must not duplicate the canonical timeline");
  assert.ok(await dialog.getByRole("link", { name: "Przejdź do Deal Room" }).isVisible());
  assert.equal(await page.locator("[data-slot='dialog-content']").innerText().then((text) => /\d+\.\d{2}\s*(?:zł|PLN)/.test(text)), false, "quick preview must use grouped whole-PLN amounts");
  await page.screenshot({ path: path.join(reviewDir, "14-finder-modal-v2.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const dialogContent = document.querySelector("[data-slot='dialog-content']"); if (dialogContent) dialogContent.scrollTop = 0; });
  const mobileLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.width, JSON.stringify(mobileLayout));
  const mobileDealRoomCta = dialog.getByRole("link", { name: "Otwórz Deal Room" }).first();
  const mobileCtaBounds = await mobileDealRoomCta.evaluate((element) => element.getBoundingClientRect().toJSON());
  assert.ok(mobileCtaBounds.left >= 0 && mobileCtaBounds.right <= mobileLayout.width, JSON.stringify({ mobileLayout, mobileCtaBounds }));
  await page.screenshot({ path: path.join(reviewDir, "15-mobile-finder-modal-v2.png"), fullPage: false });
  resultsPayload = { ...resultsPayload, results: [], reviewResults: [{ ...result, price: 63_872.55, decisionBucket: "REVIEW", lifecycleStatus: "REVIEW", reviewReason: "Cena wymaga potwierdzenia", missingFields: ["price"] }], counts: { active: 0, review: 1, archived: 0 } };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: "domcontentloaded" });
  try { await page.getByRole("heading", { name: "DO OCENY" }).waitFor({ state: "visible", timeout: 10_000 }); }
  catch (error) { console.error("Finder review reload diagnostics", { url: page.url(), title: await page.title(), apiRequests, body: await page.locator("body").innerText() }); throw error; }
  const roundedReviewPrice = page.getByText(/63\s*873\s*zł/).first();
  await roundedReviewPrice.waitFor({ state: "visible" });
  assert.doesNotMatch(await page.locator("body").innerText(), /63\s?872\.55\s*zł|63\s?872,55\s*zł/, "Finder cards must not expose fractional PLN formatting");
  assert.ok(apiRequests.every((request) => request.path.startsWith("/api/")), "all test API requests must remain local and intercepted");
  assert.ok(apiRequests.filter((request) => request.method !== "GET").every((request) => request.path.endsWith("/gallery/trace")), "only the existing non-business gallery diagnostic trace may write during render");
  assert.equal(apiRequests.some((request) => request.path.endsWith("/gallery") && request.method !== "GET"), false, "the visual proof must not create a gallery job");

  await page.goto(`${baseUrl}/properties/new`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Dodaj nieruchomość" }).waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: path.join(reviewDir, "17-manual-add-form-v3.png"), fullPage: true });
  const importUrl = page.getByLabel("Link do ogłoszenia");
  await importUrl.fill("https://www.otodom.pl/pl/oferta/testowe");
  assert.equal(await importUrl.inputValue(), "https://www.otodom.pl/pl/oferta/testowe");
  const importButton = page.getByRole("button", { name: "Importuj" });
  assert.equal(await importButton.isDisabled(), false);
  await importButton.click();
  try { await page.getByLabel("Tytuł").waitFor({ state: "visible", timeout: 10_000 }); }
  catch (error) { console.error("Manual Add import diagnostics", { apiRequests, body: await page.locator("body").innerText() }); throw error; }
  await page.getByRole("button", { name: "Zapisz nieruchomość" }).click();
  await page.getByText("Nieruchomość zapisana.", { exact: true }).waitFor({ state: "visible" });
  assert.ok(await page.getByRole("link", { name: "Wróć do nieruchomości" }).isVisible());
  assert.equal(apiRequests.some((request) => request.path.includes("/investment/initialize")), false, "Manual Add must not initialize or create an investment deal");
  assert.equal(apiRequests.filter((request) => request.path === "/api/properties" && request.method === "POST").length, 1, "the visual fixture uses only the existing explicit property save flow");
  await page.getByText("Nieruchomość zapisana.", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: path.join(reviewDir, "07-manual-add-v3.png"), fullPage: false });
});
