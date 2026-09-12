/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const listingId = "listing-command-center-fixture";
const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-12T10:00:00.000Z";

function fixtureResult(overrides = {}) {
  return {
    id: listingId, title: "Łódź · 2 pokoje · 45 m²", description: "Fixture UI bez dostępu do Production.", price: 300_000, area: 45, rooms: 2,
    floor: "2", totalFloors: "4", buildingType: "blok", ownership: "pełna własność", images: [], pricePerSqm: 6_667,
    locationText: "Łódź · Górna", address: "Testowa 1, Łódź", city: "Łódź", district: "Górna", thumbnailUrl: null,
    originalUrl: "https://www.facebook.com/groups/1/posts/2", source: "facebook", listingStatus: "active", isActive: true,
    firstSeenAt: now, lastSeenAt: now, firstMatchedAt: now, lastMatchedAt: now, previousPrice: null, currentPrice: 300_000,
    isNew: false, hasPriceDrop: false, priceDropAmount: null, matchReasons: [], unknownFields: [], decisionBucket: "MATCHED",
    lifecycleStatus: "ACTIVE", reviewReason: null, missingFields: [], manualDecision: null, galleryStatus: "NOT_REQUESTED",
    galleryJobId: null, galleryTotal: 0, galleryPersistedCount: 0, galleryError: null,
    ...overrides,
  };
}

async function makeDeal({ listingOverrides = {}, overrides = {} } = {}) {
  const { buildCanonicalDeal } = await import("../engine.ts");
  const { DEFAULT_UNDERWRITING_SETTINGS } = await import("../../flip-finder/underwriting.ts");
  return buildCanonicalDeal({
    dealId: "deal-command-center-fixture", now, overrides, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: {
      id: "comps-fixture", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80,
      provenance: "DERIVED", compCount: 3, fallbackLevel: 0, fallbackReason: null, confidencePenalty: 0, observedAt: now,
      evidenceId: "resale-comps-fixture", priceEvidenceType: "ASKING",
      comparables: [1, 2, 3].map((index) => ({ id: `comp-${index}`, source: "Test comp", sourceUrl: `https://example.test/${index}`, pricePerM2: 9_500 + index * 250, similarityScore: 86 - index, dataQuality: 90, freshnessDays: index * 3, distanceMeters: index * 150, adjustments: ["AREA_MATCH"], weight: 0.8 - index * 0.05, outlierReason: null, priceEvidenceType: "ASKING" })),
    },
    listing: {
      id: listingId, source: "facebook", sourceUrl: "https://www.facebook.com/groups/1/posts/2", externalListingId: "2",
      lifecycleStatus: "REVIEW", decisionBucket: "REVIEW", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1",
      areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978,
      ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000,
      askingPricePerM2: null, galleryStatus: "NOT_REQUESTED", imageCount: 0, identityExact: true, observedAt: now, conflicts: [],
      ...listingOverrides,
    },
  });
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

test("Investment Command Center visual QA uses only a generated local fixture", { timeout: 180_000 }, async (t) => {
  let deal = await makeDeal();
  const filter = {
    id: filterId, name: "Local UI fixture", sources: ["facebook"], city: "Łódź", districts: [], priceMin: null, priceMax: null,
    areaMin: null, areaMax: null, rooms: [], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false,
    buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 12_000, requiredKeywords: [], excludedKeywords: [],
    minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true,
    lastScannedAt: now, createdAt: now, updatedAt: now, totalMatches: 1, newMatches: 0, lastScan: null,
  };
  let result = fixtureResult();
  let resultsPayload = { filter, results: [result], reviewResults: [], archivedResults: [], counts: { active: 1, review: 0, archived: 0 }, total: 1, newMatches: 0, lastScan: null, sourceScans: [] };
  const port = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const reviewDir = path.join(root, "artifacts", "command-center-review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-ui-only",
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SERVICE_ROLE_KEY: "local-ui-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-10_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-10_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/flip-finder`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const apiRequests = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiRequests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/flip-finder/search-filters") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 1, activeListings: 0, removedListings: 0, newMatches: 0 } }) });
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resultsPayload) });
    if (url.pathname === `/api/flip-finder/listings/${listingId}/investment` && request.method() === "GET") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, code: "NOT_COMPUTED" }) });
    if (url.pathname === `/api/flip-finder/listings/${listingId}/investment/initialize` && request.method() === "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal }) });
    if (url.pathname === `/api/flip-finder/listings/${listingId}/investment` && request.method() === "PUT") {
      const body = request.postDataJSON();
      deal = await makeDeal({ overrides: body.overrides ?? {} });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  const listingCard = page.getByRole("button", { name: /Łódź · 2 pokoje · 45 m²/ }).first();
  await listingCard.waitFor({ state: "visible", timeout: 20_000 });
  await listingCard.click();
  await page.getByRole("tab", { name: "Investment Desk" }).click();
  await page.getByText("Flip Investment OS · Command Center", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByText("MAX BUY", { exact: true }).waitFor({ state: "visible" });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  assert.equal(await page.getByText("ANALIZA GOTOWA", { exact: true }).count(), 2, "CEO COMPLETE should read as analysis completion in the command center and board");
  assert.ok(await page.getByText(/BUY GATE BLOCKED/).isVisible(), "the blocked purchase gate must remain explicit");
  const initialNextAction = await page.getByText(/Oferta otwierająca:/).innerText();
  assert.match(initialNextAction, /\d[\d\s\u00a0]*zł\./, `opening offer should use the shared PLN formatter: ${initialNextAction}`);
  assert.doesNotMatch(initialNextAction, /\d\.\d{2}/, "opening offer must not expose raw grosze precision");
  assert.doesNotMatch(await page.locator("[data-slot='dialog-content']").innerText(), /213105\.03/, "the UI should not expose the engine's raw opening amount");
  const riskPresentation = await page.locator("[data-command-primary-risk]:visible").first().innerText();
  assert.match(riskPresentation, /NAJWIĘKSZE RYZYKO/);
  assert.match(riskPresentation, /zł/);
  assert.doesNotMatch(riskPresentation, /\d\.\d{2}/, "risk amount should use the shared PLN formatter");
  const genericFinding = page.getByText(/completed with confidence \d+/i).first();
  assert.ok(await genericFinding.count(), "full generic finding remains available in progressive disclosure");
  assert.equal(await genericFinding.isVisible(), false, "generic director findings should not be repeated in collapsed cards");
  const genericRecommendation = page.getByText("Pass only validated output downstream.", { exact: true }).first();
  if (await genericRecommendation.count()) assert.equal(await genericRecommendation.isVisible(), false, "generic director recommendations should be secondary");
  assert.ok(await page.locator("[data-director-collapsed-finding]").count() > 0, "meaningful director findings should remain in collapsed cards");
  assert.equal(await page.getByText("Brak dodatkowych ustaleń.", { exact: true }).count(), 0, "cards without a meaningful finding should not add repeated filler");
  assert.doesNotMatch(await page.locator("[data-slot='dialog-content']").innerText(), /63872\.55/, "the same risk amount should stay formatted throughout the command center");

  await page.evaluate(() => { const dialog = document.querySelector("[data-slot='dialog-content']"); if (dialog) dialog.scrollTop = 0; });
  await page.screenshot({ path: path.join(reviewDir, "01-desktop-top-final.png") });
  await page.locator("#director-board-title").evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(reviewDir, "02-desktop-directors-final.png") });
  await page.getByRole("tab", { name: "AUDIT" }).click();
  await page.locator("[data-audit-desktop-table]").waitFor({ state: "visible" });
  await page.getByText("Provenance faktów", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(reviewDir, "03-desktop-audit-final.png") });
  assert.equal(await page.locator("[data-audit-desktop-table] table tbody tr").count(), Object.keys(deal.facts).length, "desktop audit should retain the complete fact table");
  await page.getByRole("tab", { name: "OVERVIEW" }).click();
  await page.evaluate(() => { const dialog = document.querySelector("[data-slot='dialog-content']"); if (dialog) dialog.scrollTop = 0; });

  for (const [index, viewport] of [{ width: 1440, height: 900, label: "desktop" }, { width: 768, height: 1024, label: "tablet" }, { width: 390, height: 844, label: "mobile" }].entries()) {
    if (index > 0) await page.keyboard.press("Escape");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (index > 0) {
      await page.getByRole("button", { name: /Łódź · 2 pokoje · 45 m²/ }).first().click();
      await page.getByRole("tab", { name: "Investment Desk" }).click();
      await page.getByText("MAX BUY", { exact: true }).waitFor({ state: "visible" });
    }
    await page.screenshot({ path: path.join(os.tmpdir(), `investment-command-center-${viewport.label}.png`) });
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector("[data-slot='dialog-content']");
      const rect = dialog?.getBoundingClientRect();
      const command = document.querySelector("#command-center-title")?.closest("section");
      const metricTop = (label) => [...document.querySelectorAll("p")].find((node) => node.textContent?.trim() === label)?.parentElement?.getBoundingClientRect().top;
      const metric = [...document.querySelectorAll("p")].find((node) => node.textContent?.trim() === "MAX BUY")?.parentElement;
      const inner = command?.querySelector(".grid");
      const visibleRisk = [...document.querySelectorAll("[data-command-primary-risk]")].find((node) => node.getBoundingClientRect().height > 0);
      return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, dialogLeft: rect?.left, dialogRight: rect?.right, dialogWidth: rect?.width, commandRight: command?.getBoundingClientRect().right, commandWidth: command?.getBoundingClientRect().width, gridRight: inner?.getBoundingClientRect().right, gridWidth: inner?.getBoundingClientRect().width, gridColumns: inner ? getComputedStyle(inner).gridTemplateColumns : null, metricRight: metric?.getBoundingClientRect().right, metricWidth: metric?.getBoundingClientRect().width, titleTop: document.querySelector("#command-center-title")?.getBoundingClientRect().top, maxBuyTop: metric?.getBoundingClientRect().top, profitTop: metricTop("EXPECTED PROFIT"), roiTop: metricTop("ROI"), riskTop: visibleRisk?.getBoundingClientRect().top, nextVisible: [...document.querySelectorAll("p")].find((node) => node.textContent?.trim() === "Next best action")?.getBoundingClientRect().top, nextButtonTop: [...document.querySelectorAll("button")].find((node) => node.textContent?.includes("Otwórz plan działania"))?.getBoundingClientRect().top };
    });
    assert.ok(layout.titleTop != null && layout.titleTop < viewport.height, `${viewport.label}: CEO action should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.maxBuyTop != null && layout.maxBuyTop < viewport.height, `${viewport.label}: MAX BUY should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.profitTop != null && layout.profitTop < viewport.height, `${viewport.label}: profit should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.roiTop != null && layout.roiTop < viewport.height, `${viewport.label}: ROI should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.riskTop != null && layout.riskTop < viewport.height, `${viewport.label}: primary risk should be above fold; ${JSON.stringify(layout)}`);
    const missingInfoAboveFold = await page.locator("[data-command-missing-info]").evaluateAll((elements) => elements.some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
    }));
    assert.ok(missingInfoAboveFold, `${viewport.label}: missing information should be above fold`);
    assert.ok(layout.nextVisible != null && layout.nextVisible < viewport.height, `${viewport.label}: next action should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.nextButtonTop != null && layout.nextButtonTop < viewport.height, `${viewport.label}: next action CTA should be above fold; ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.width, `${viewport.label}: unexpected page horizontal overflow ${JSON.stringify(layout)}`);
    assert.ok(layout.dialogLeft != null && layout.dialogLeft >= 0 && layout.dialogRight <= viewport.width, `${viewport.label}: details dialog exceeds viewport ${JSON.stringify(layout)}`);
    assert.ok(layout.commandRight != null && layout.commandRight <= viewport.width, `${viewport.label}: command content exceeds viewport ${JSON.stringify(layout)}`);
    if (viewport.label === "mobile") await page.screenshot({ path: path.join(reviewDir, "04-mobile-top-final.png") });
  }

  await page.locator("#director-board-title").evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(reviewDir, "05-mobile-directors-final.png") });
  await page.getByRole("tab", { name: "AUDIT" }).click();
  await page.getByText("Evidence Fabric", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-audit-desktop-table]").isVisible(), false, "mobile should use stacked audit cards instead of a squeezed desktop table");
  assert.ok(await page.locator("[data-audit-mobile-cards]").isVisible(), "mobile audit cards should be visible");
  assert.equal(await page.locator("[data-audit-mobile-cards] article").count(), Object.keys(deal.facts).length, "mobile audit should retain each fact record");
  assert.equal(await page.locator("[data-audit-mobile-cards] article > div:first-child > span").count(), Object.keys(deal.facts).length, "every mobile audit card should expose a status label");
  assert.ok(await page.getByText("EFFECTIVE VALUE", { exact: true }).first().isVisible());
  assert.ok(await page.getByText("SOURCE / PROVENANCE", { exact: true }).first().isVisible());
  await page.getByText("Provenance faktów", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(reviewDir, "06-mobile-audit-final.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "mobile audit must not widen the page");
  await page.getByRole("tab", { name: "PLAYBOOK" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "AUDIT" }).getAttribute("aria-selected"), "true");
  await page.getByRole("tab", { name: "OVERVIEW" }).click();
  await page.getByRole("heading", { name: "Assumptions & overrides" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(reviewDir, "07-mobile-overrides-final.png") });
  await page.getByLabel("Nowa wartość ręczna").first().fill("290000");
  await page.getByText(/290.?000 · draft/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Zapisz i przelicz" }).click();
  await page.getByRole("tab", { name: "AUDIT" }).click();
  const askingPriceAuditCard = page.locator('[data-audit-mobile-cards] article[aria-label="Audyt: Asking Price"]');
  await askingPriceAuditCard.waitFor({ state: "visible" });
  await askingPriceAuditCard.getByText("CONFLICT", { exact: true }).waitFor({ state: "visible" });
  assert.ok(await askingPriceAuditCard.getByText("CONFLICT", { exact: true }).isVisible(), "asking price override must preserve its conflict signal");
  await askingPriceAuditCard.locator("details summary").click();
  assert.match(await askingPriceAuditCard.innerText(), /SYSTEM VALUE[\s\S]*300[\s\u00a0]?000[\s\S]*MANUAL VALUE[\s\S]*290[\s\u00a0]?000/);
  assert.match(await askingPriceAuditCard.innerText(), /EVIDENCE ID[\s\S]*override:/);
  assert.ok(apiRequests.some((item) => item.method === "POST" && item.path.endsWith("/investment/initialize")), "existing NOT_COMPUTED initialize flow should run once through local fixture");
  assert.equal(apiRequests.filter((item) => item.method === "PUT" && item.path.endsWith("/investment")).length, 1, "manual override should keep the existing PUT path");

  result = fixtureResult({ title: "Łódź · dane niepełne", price: null, area: null, rooms: null, address: null });
  resultsPayload = { ...resultsPayload, results: [result] };
  deal = await makeDeal({ listingOverrides: { askingPrice: null, areaM2: null, rooms: null, street: null, buildingType: null } });
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Łódź · dane niepełne/ }).first().click();
  await page.getByRole("tab", { name: "Investment Desk" }).click();
  await page.getByText("Flip Investment OS · Command Center", { exact: true }).waitFor({ state: "visible" });
  assert.ok(await page.locator("[data-command-missing-info]:visible").isVisible(), "missing-data deal should remain legible in the command center");
  const missingDataText = await page.locator("[data-command-missing-info]:visible").innerText();
  assert.ok(missingDataText.length > 0);
  assert.doesNotMatch(await page.locator("[data-slot='dialog-content']").innerText(), /NaN|Infinity/);
  await page.close();

  assert.ok(apiRequests.every((request) => request.path.startsWith("/api/")), "all application API requests must remain intercepted");
  assert.match(output, /Ready|Local:/, `Next dev output should not contain an app error: ${output}`);
});
