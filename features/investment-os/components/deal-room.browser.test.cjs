/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const listingId = "listing-deal-room-fixture";
const now = "2026-09-13T09:00:00.000Z";

async function makeDeal() {
  const { buildCanonicalDeal } = await import("../engine.ts");
  const { DEFAULT_UNDERWRITING_SETTINGS } = await import("../../flip-finder/underwriting.ts");
  return buildCanonicalDeal({
    dealId: "deal-room-fixture", now, overrides: {}, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: { id: "comps-fixture", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80, provenance: "DERIVED", compCount: 3, fallbackLevel: 0, fallbackReason: null, confidencePenalty: 0, observedAt: now, evidenceId: "comps-fixture", priceEvidenceType: "ASKING", comparables: [1, 2, 3].map((index) => ({ id: `comp-${index}`, source: "Oferta porównawcza", sourceUrl: `https://example.test/${index}`, pricePerM2: 9_500 + index * 250, similarityScore: 88 - index, dataQuality: 90, freshnessDays: index * 4, distanceMeters: index * 150, adjustments: ["AREA_MATCH"], weight: 0.8, outlierReason: null, priceEvidenceType: "ASKING" })) },
    listing: { id: listingId, source: "facebook", sourceUrl: "https://www.facebook.com/groups/1/posts/2", externalListingId: "2", lifecycleStatus: "REVIEW", decisionBucket: "REVIEW", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978, ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000, askingPricePerM2: null, galleryStatus: "NOT_REQUESTED", imageCount: 0, identityExact: true, observedAt: now, conflicts: [] },
  });
}

function withoutCeoResult(deal) { const value = structuredClone(deal); value.ceo.status = "WAITING"; value.ceo.confidence = null; value.ceo.result = null; return value; }

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); }); }); }
async function waitForServer(url, timeoutMs = 60_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const ready = await new Promise((resolve) => { const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode === 200); }); request.setTimeout(1_000, () => request.destroy()); request.once("error", () => resolve(false)); }); if (ready) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Lokalna strona Deal Room nie zwróciła HTTP 200 w 60 sekund: ${url}`); }

test("Premium Deal Room renders the reviewed local fixture and its executive presentation on desktop and mobile", { timeout: 180_000 }, async (t) => {
  const deal = await makeDeal();
  const root = path.resolve(__dirname, "../../..");
  const reviewDir = process.env.MASTERCLASS_REVIEW_SCREENSHOT_DIR?.trim() || path.join(root, "artifacts", "flip-manager-v3-review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const port = await freePort();
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, NODE_ENV: "development", DEBUG: "", NEXT_TEST_MODE: "", __NEXT_TEST_MODE: "", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-ui-only", NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-ui-only", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "local-ui-only" }, stdio: "ignore" });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/deals/${listingId}`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let currentDeal = deal;
  let currentMedia = [];
  let notComputed = false;
  const investmentRequests = [];
  const initializeRequests = [];
  const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route("https://cdn.example.test/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/broken.jpg") return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    return route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const investmentPath = `/api/flip-finder/listings/${listingId}/investment`;
    if (url.pathname === investmentPath || url.pathname === `${investmentPath}/initialize`) {
      if (url.pathname.endsWith("/initialize")) {
        initializeRequests.push({ method: request.method(), path: url.pathname, headers: request.headers() });
        if (initializeRequests.length === 1) {
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, message: "fixture failure" }) });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        notComputed = false;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal: currentDeal, media: currentMedia }) });
      }
      investmentRequests.push({ method: request.method(), path: url.pathname });
      return notComputed
        ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, code: "NOT_COMPUTED" }) })
        : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal: currentDeal, media: currentMedia }) });
    }
    return route.continue();
  });
  await page.goto(`${baseUrl}/deals/${listingId}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("Maks. cena zakupu", { exact: true }).waitFor({ state: "visible" });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  assert.equal(await page.locator("[data-deal-gallery]").count(), 0, "no gallery shell is shown when the listing has no images");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(reviewDir, "01-deal-room-top-v3.png"), fullPage: false });
  await page.screenshot({ path: path.join(reviewDir, "04-deal-room-desktop.png"), fullPage: true });
  assert.equal(await page.locator("[data-deal-room]").count(), 1);
  assert.equal(await page.locator("[data-initialize-deal]").count(), 0, "an existing deal must not show the explicit initialize action");
  assert.ok(await page.getByText("Rekomendacja systemu", { exact: true }).first().isVisible());
  assert.equal(await page.getByText("Decyzja CEO", { exact: true }).count(), 0, "a deterministic action token must not be presented as an authored CEO decision");
  assert.equal(await page.getByText("Brak zapisanej rekomendacji CEO.", { exact: true }).count(), 0, "the action must not contradict a missing-CEO fallback");
  assert.ok(await page.getByText("Działanie wskazane przez bieżącą analizę", { exact: true }).isVisible());
  assert.equal(await page.getByText("Działanie wskazane przez bieżący wynik CEO", { exact: true }).count(), 0, "system analysis copy must not imply a separate CEO-authored decision");
  assert.ok(await page.getByText("Kompletność danych oferty", { exact: true }).isVisible());
  assert.ok(await page.getByText("Co zmieni rekomendację systemu?", { exact: true }).isVisible());
  assert.equal(await page.getByText("Kompletność analizy", { exact: true }).count(), 0, "listing facts are not the completeness of the whole analysis");
  assert.ok(await page.getByText("Maks. cena zakupu", { exact: true }).first().isVisible());
  assert.ok(await page.getByText("Oczekiwany zysk", { exact: true }).first().isVisible());
  const summaryTab = page.getByRole("tab", { name: "Podsumowanie" });
  await summaryTab.focus();
  await summaryTab.press("ArrowRight");
  const marketTab = page.getByRole("tab", { name: "Rynek" });
  assert.equal(await marketTab.getAttribute("aria-selected"), "true");
  assert.equal(await marketTab.evaluate((element) => document.activeElement === element), true);
  await page.getByRole("tab", { name: "Podsumowanie" }).click();
  assert.equal(await page.locator("[role=tablist] [role=tab]").count(), 8);
  await page.getByRole("heading", { name: "Zespół analityczny" }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByText("Wniosek nie został zapisany.", { exact: true }).count(), 0, "completed directors without a finding must not show a fabricated failure statement");
  const directorButton = page.getByRole("button", { name: /Rozpoznanie/ }).first();
  assert.equal(await directorButton.getAttribute("aria-expanded"), "false");
  const collapsedHeights = await page.locator("[data-director-collapsed-finding]").evaluateAll((nodes) => nodes.map((node) => node.closest("button").getBoundingClientRect().height));
  await directorButton.click();
  assert.equal(await directorButton.getAttribute("aria-expanded"), "true");
  const expandedHeights = await page.locator("[data-director-collapsed-finding]").evaluateAll((nodes) => nodes.map((node) => node.closest("button").getBoundingClientRect().height));
  assert.deepEqual(expandedHeights, collapsedHeights, "opening one director must not stretch the other grid cards");
  const directorPanelId = await directorButton.getAttribute("aria-controls");
  assert.ok(directorPanelId);
  assert.equal(await page.locator(`#${directorPanelId}`).isVisible(), true, "director details should appear in the shared panel below the grid");
  await page.locator('section[aria-labelledby="director-council-title"]').screenshot({ path: path.join(reviewDir, "02-deal-room-directors-v3.png") });
  assert.equal(await page.getByText("Brak dodatkowej notatki.", { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /Zapisano zdarzenie|Zaktualizowano analizę/, "the executive timeline must not invent generic state transitions");
  assert.equal(await page.locator("[data-executive-timeline]").getByText(/Pokaż pełną historię/).count(), 1, "low-level evidence remains available in the full history disclosure");
  await page.locator("[data-executive-timeline]").screenshot({ path: path.join(reviewDir, "03-deal-room-timeline-v3.png") });
  const fullHistory = page.getByText(/Pokaż pełną historię/);
  await fullHistory.click();
  await page.getByText("Dowód:", { exact: false }).first().waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(reviewDir, "14-deal-room-audit-v2.png"), fullPage: false });
  const visibleQuestions = page.locator("[data-user-questions]:visible").first();
  await visibleQuestions.waitFor({ state: "visible" });
  await visibleQuestions.screenshot({ path: path.join(reviewDir, "04-deal-room-questions-v3.png") });
  await page.getByRole("tab", { name: "Negocjacje" }).click();
  await page.locator("#deal-panel").screenshot({ path: path.join(reviewDir, "05-deal-room-negotiation-v3.png") });
  await page.getByRole("tab", { name: "Rynek" }).click(); await page.getByText("Źródło wyceny", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Finanse" }).click(); await page.getByText("Granice zakupu", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Ryzyka" }).click(); await page.getByText("Ryzyka CEO", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Źródła i audyt" }).click(); await page.getByText("Pochodzenie faktów", { exact: true }).waitFor({ state: "visible" });
  const englishVariant = structuredClone(deal);
  englishVariant.ceo.result.recommendation = "Do not proceed.";
  currentDeal = englishVariant;
  await page.reload({ waitUntil: "domcontentloaded" });
  try { await page.locator("[data-deal-room]").waitFor({ state: "visible", timeout: 10_000 }); }
  catch (error) { console.error("Deal fixture reload diagnostics", { investmentRequests, body: await page.locator("body").innerText() }); throw error; }
  assert.ok(await page.getByText("Rekomendacja systemu", { exact: true }).isVisible());
  assert.equal(await page.getByText("Brak zapisanej rekomendacji CEO.", { exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /Do not proceed\./);
  currentDeal = withoutCeoResult(deal);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible" });
  assert.ok(await page.getByText("Oczekuje na wynik", { exact: true }).count() > 0);
  assert.ok(await page.getByText("Decyzja pojawi się po zapisaniu wyniku analizy.", { exact: true }).isVisible());
  assert.doesNotMatch(await page.locator("body").innerText(), /\b(?:NEGOTIATE|BUY|REJECT|MAX BUY|EXPECTED PROFIT|NEXT BEST ACTION|COMPLETE|BLOCKED)\b/);
  await page.screenshot({ path: path.join(reviewDir, "06-deal-room-empty-state.png"), fullPage: true });
  currentDeal = deal;

  currentMedia = ["https://cdn.example.test/photo-1.jpg", "https://cdn.example.test/photo-2.jpg", "https://cdn.example.test/photo-3.jpg"];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-gallery]").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-deal-gallery] img").count(), 3, "three listing images render in a bounded grid/gallery");

  currentMedia = ["https://cdn.example.test/photo-1.jpg"];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-gallery]").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-deal-gallery] img").count(), 1, "a single listing image renders as one large preview");

  currentMedia = ["https://cdn.example.test/broken.jpg"];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator("[data-deal-gallery]").count(), 0, "a broken/missing image never breaks the Deal Room; the gallery hides itself once nothing renders");
  assert.ok(await page.getByText("Maks. cena zakupu", { exact: true }).first().isVisible(), "the rest of the Deal Room keeps rendering when an image fails");
  currentMedia = [];

  await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Podsumowanie" }).click(); await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(reviewDir, "08-mobile-deal-room-v3.png"), fullPage: false });
  const mobileLayout = await page.evaluate(() => { const topFor = (label) => [...document.querySelectorAll("p")].find((node) => node.textContent?.trim() === label)?.parentElement?.getBoundingClientRect().top; return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, recommendationTop: topFor("Rekomendacja systemu"), maxBuyTop: topFor("Maks. cena zakupu"), profitTop: topFor("Oczekiwany zysk"), roiTop: topFor("Zwrot z inwestycji (ROI)") }; });
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.width, JSON.stringify(mobileLayout)); assert.ok(mobileLayout.recommendationTop != null && mobileLayout.recommendationTop < 844, JSON.stringify(mobileLayout)); assert.ok(mobileLayout.maxBuyTop != null && mobileLayout.maxBuyTop < 844, JSON.stringify(mobileLayout)); assert.ok(mobileLayout.profitTop != null && mobileLayout.profitTop < 844, JSON.stringify(mobileLayout)); assert.ok(mobileLayout.roiTop != null && mobileLayout.roiTop < 844, JSON.stringify(mobileLayout));
  await page.getByRole("heading", { name: "Zespół analityczny" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(reviewDir, "10-mobile-directors-v2.png"), fullPage: false });
  await page.getByRole("heading", { name: "Pytania do Ciebie" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(reviewDir, "11-mobile-questions-v2.png"), fullPage: false });
  await page.getByRole("tab", { name: "Negocjacje" }).click();
  await page.locator("#deal-panel").scrollIntoViewIfNeeded();
  const mobileNegotiation = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(mobileNegotiation.scrollWidth <= mobileNegotiation.width, JSON.stringify(mobileNegotiation));
  await page.screenshot({ path: path.join(reviewDir, "16-mobile-negotiation-v2.png"), fullPage: false });
  const staleDeal = structuredClone(deal);
  staleDeal.scout.status = "STALE";
  currentDeal = staleDeal;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: "domcontentloaded" });
  try { await page.locator("[data-deal-room]").waitFor({ state: "visible", timeout: 20_000 }); }
  catch (error) { console.error("Stale-deal reload diagnostics", { investmentRequests, body: await page.locator("body").innerText() }); throw error; }
  assert.equal(await page.locator("[data-initialize-deal]").count(), 0, "a stale existing deal keeps its existing refresh flow, not the NOT_COMPUTED initialize CTA");
  assert.equal(await page.getByRole("button", { name: "Odśwież analizę" }).count(), 1, "the established stale-deal refresh action remains available");

  notComputed = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-investment-initialize-state]").waitFor({ state: "visible" });
  assert.match(await page.locator("[data-investment-initialize-state] h2").innerText(), /Analiza nie zosta/);
  assert.equal(await page.getByRole("button", { name: "PRZYGOTUJ ANALIZĘ" }).count(), 1);
  assert.equal(initializeRequests.length, 0, "opening a NOT_COMPUTED Deal Room must not initialize automatically");
  assert.equal(investmentRequests.at(-1).method, "GET");
  await page.screenshot({ path: path.join(reviewDir, "07-explicit-initialize-cta.png"), fullPage: false });

  await page.getByRole("button", { name: "PRZYGOTUJ ANALIZĘ" }).click();
  await page.getByRole("alert").getByText(/Nie udało się przygotować analizy/).waitFor({ state: "visible" });
  assert.equal(initializeRequests.length, 1, "one explicit click sends one initialize request");
  await page.waitForTimeout(250);
  assert.equal(initializeRequests.length, 1, "a failed initialization must not retry automatically");
  assert.equal(await page.getByRole("button", { name: "SPRÓBUJ PONOWNIE" }).count(), 1);
  assert.equal(initializeRequests[0].method, "POST");
  assert.equal(initializeRequests[0].headers["x-flip-finder-action"], "investment-os");

  const getsBeforeSuccess = investmentRequests.filter((request) => request.method === "GET").length;
  await page.getByRole("button", { name: "SPRÓBUJ PONOWNIE" }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.getByRole("status").getByText("PRZYGOTOWUJĘ ANALIZĘ", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "PRZYGOTOWUJĘ ANALIZĘ" }).isDisabled(), true);
  await page.locator("[data-deal-room]").waitFor({ state: "visible" });
  assert.equal(initializeRequests.length, 2, "two immediate click events must be deduplicated to one retry POST");
  assert.equal(investmentRequests.filter((request) => request.method === "GET").length, getsBeforeSuccess + 1, "a successful initialize must refetch the canonical GET before rendering the room");
  assert.equal(await page.locator("[data-initialize-deal]").count(), 0, "the CTA disappears once the canonical deal is available");
  assert.equal(await page.getByText("Maks. cena zakupu", { exact: true }).count(), 1, "the Premium Deal Room renders from the canonical GET result");
});
