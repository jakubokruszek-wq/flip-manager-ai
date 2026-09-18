/* eslint-disable @typescript-eslint/no-require-imports */
// Acceptance regression for Deal Room Brain V1: proves the Brain-wired Deal Room
// renders CEO recommendation, a single Next Best Action, real director statuses,
// director detail, questions, and a conflict-driven risk card entirely from the
// existing canonical GET — with zero POST/PUT/PATCH/DELETE during initial render
// and no overflow on mobile. Does not exercise or modify app logic.
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const listingId = "listing-brain-acceptance-fixture";
const now = "2026-09-13T09:00:00.000Z";

async function makeDeal() {
  const { buildCanonicalDeal } = await import("../engine.ts");
  const { DEFAULT_UNDERWRITING_SETTINGS } = await import("../../flip-finder/underwriting.ts");
  return buildCanonicalDeal({
    dealId: "deal-brain-acceptance-fixture", now, overrides: {}, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: { id: "comps-fixture", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80, provenance: "DERIVED", compCount: 3, fallbackLevel: 0, fallbackReason: null, confidencePenalty: 0, observedAt: now, evidenceId: "comps-fixture", priceEvidenceType: "ASKING", comparables: [1, 2, 3].map((index) => ({ id: `comp-${index}`, source: "Oferta porównawcza", sourceUrl: `https://example.test/${index}`, pricePerM2: 9_500 + index * 250, similarityScore: 88 - index, dataQuality: 90, freshnessDays: index * 4, distanceMeters: index * 150, adjustments: ["AREA_MATCH"], weight: 0.8, outlierReason: null, priceEvidenceType: "ASKING" })) },
    listing: { id: listingId, source: "facebook", sourceUrl: "https://www.facebook.com/groups/1/posts/2", externalListingId: "2", lifecycleStatus: "REVIEW", decisionBucket: "REVIEW", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978, ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000, askingPricePerM2: null, galleryStatus: "NOT_REQUESTED", imageCount: 0, identityExact: true, observedAt: now, conflicts: [] },
  });
}

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => (error ? reject(error) : resolve(port))); }); }); }
async function waitForServer(url, timeoutMs = 60_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const ready = await new Promise((resolve) => { const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode === 200); }); request.setTimeout(1_000, () => request.destroy()); request.once("error", () => resolve(false)); }); if (ready) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`Local Deal Room did not return HTTP 200 within ${timeoutMs}ms: ${url}`); }

test("Deal Room Brain V1 renders CEO recommendation, one Next Best Action, real director statuses, director detail, questions and conflict risk from a pure GET, with zero writes on initial render and no mobile overflow", { timeout: 180_000 }, async (t) => {
  const deal = await makeDeal();
  const root = path.resolve(__dirname, "../../..");
  const port = await freePort();
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, NODE_ENV: "development", DEBUG: "", NEXT_TEST_MODE: "", __NEXT_TEST_MODE: "", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-ui-only", NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-ui-only", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "local-ui-only" }, stdio: "ignore" });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/deals/${listingId}`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const investmentPath = `/api/flip-finder/listings/${listingId}/investment`;
  const requests = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === investmentPath || url.pathname === `${investmentPath}/initialize`) {
      requests.push({ method: request.method(), path: url.pathname });
      if (url.pathname.endsWith("/initialize")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, deal }) });
    }
    return route.continue();
  });

  // --- Initial render: a deal already exists (canonical GET only) ---
  await page.goto(`${baseUrl}/deals/${listingId}`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("Maks. cena zakupu", { exact: true }).waitFor({ state: "visible" });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  const nonGetOnInitialRender = requests.filter((request) => request.method !== "GET");
  assert.equal(nonGetOnInitialRender.length, 0, `initial render must issue zero POST/PUT/PATCH/DELETE, got: ${JSON.stringify(nonGetOnInitialRender)}`);
  assert.ok(requests.some((request) => request.method === "GET"), "initial render must still read the canonical deal via GET");

  // --- CEO recommendation + single Next Best Action ---
  assert.ok(await page.getByText("Rekomendacja systemu", { exact: true }).isVisible());
  const ceoRail = page.locator('section:has-text("Rekomendacja systemu")').first();
  assert.ok((await ceoRail.innerText()).trim().length > 0);
  assert.ok(await page.getByText("Następny krok", { exact: true }).first().isVisible());
  const nextActionCard = page.locator('section:has-text("Następny krok")').first();
  const nextActionText = await nextActionCard.innerText();
  assert.doesNotMatch(nextActionText, /Oczekuje na wynik analizy/, "the Brain must always name one concrete Next Best Action for a computed deal");

  // --- Director statuses visible for all ten mission directors ---
  await page.getByRole("heading", { name: "Zespół analityczny" }).scrollIntoViewIfNeeded();
  const directorLabels = ["Rozpoznanie", "Weryfikacja", "Rynek", "Remont", "Analiza finansowa", "Ryzyko i prawo", "Finanse", "Zakup", "Sprzedaż", "CEO"];
  for (const label of directorLabels) assert.ok(await page.getByText(label, { exact: true }).first().isVisible(), `director card missing: ${label}`);
  assert.equal(await page.getByText("WAITING", { exact: true }).count(), 0, "no director may render the raw internal WAITING status code");

  // --- Director detail works (a Brain-only director, not one already covered by the engine) ---
  const riskLegalButton = page.getByRole("button", { name: /Ryzyko i prawo/ }).first();
  assert.equal(await riskLegalButton.getAttribute("aria-expanded"), "false");
  await riskLegalButton.click();
  assert.equal(await riskLegalButton.getAttribute("aria-expanded"), "true");
  const panelId = await riskLegalButton.getAttribute("aria-controls");
  const detailPanel = page.locator(`#${panelId}`);
  await detailPanel.waitFor({ state: "visible" });
  const detailText = await detailPanel.innerText();
  assert.ok(detailText.length > 0);
  assert.doesNotMatch(detailText, /Oczekuje na osobny, zapisany wynik\./, "a Brain-covered director must not fall back to the dead placeholder copy");

  // --- Questions visible ---
  const questions = page.locator("[data-user-questions]:visible").first();
  await questions.scrollIntoViewIfNeeded();
  await questions.waitFor({ state: "visible" });
  assert.match(await questions.innerText(), /Pytania do Ciebie/);

  // --- Conflict / risk visible and Brain-derived (not the generic fallback) ---
  await page.evaluate(() => window.scrollTo(0, 0));
  const riskCard = page.locator('section:has-text("Największe ryzyko")').first();
  await riskCard.waitFor({ state: "visible" });
  const riskText = await riskCard.innerText();
  assert.doesNotMatch(riskText, /Nie ustalono/, "a deal with an open conflict must not show 'Nie ustalono'");

  // --- No writes were triggered by any of the above client-side interactions ---
  const nonGetAfterInteractions = requests.filter((request) => request.method !== "GET");
  assert.equal(nonGetAfterInteractions.length, 0, "expanding a director, scrolling and reading questions/risk must not trigger any write request");

  // --- Mobile: no horizontal overflow ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-deal-room]").waitFor({ state: "visible" });
  const mobileLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.width, `mobile viewport overflows horizontally: ${JSON.stringify(mobileLayout)}`);

  const nonGetTotal = requests.filter((request) => request.method !== "GET");
  assert.equal(nonGetTotal.length, 0, "the entire acceptance scenario for an already-computed deal must never issue a write request");
});
