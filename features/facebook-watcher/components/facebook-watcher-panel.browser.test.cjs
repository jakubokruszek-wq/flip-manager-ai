/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { waitForServer } = require("./browser-readiness.cjs");

const now = "2026-09-06T12:00:00.000Z";

function makeListing(overrides) {
  return {
    title: "Mieszkanie 3 pokoje, Widzew",
    city: "Łódź",
    district: "Widzew",
    neighborhood: "Stoki",
    street: "ul. Przykładowa 12",
    price: 450_000,
    priceProvenance: "AUTHORITATIVE_TEXT",
    pricePerM2: 7500,
    area: 60,
    rooms: 3,
    floor: 2,
    totalFloors: 4,
    marketType: "secondary",
    sellerType: "private",
    condition: "renovation",
    description: "Przykładowy opis oferty testowej.",
    originalUrl: null,
    images: [],
    confidence: 0.9,
    flags: [],
    listingId: "00000000-0000-4000-8000-000000000001",
    status: "active",
    groupName: "Mieszkania Łódź",
    publishedAt: now,
    opportunityScore: 78,
    crossSourceMatch: false,
    source: "facebook",
    workflowStatus: "new",
    readAt: null,
    importedAt: now,
    flipScore: 65,
    pricePerSqm: 7500,
    potentialProfit: 40_000,
    isNew: true,
    highPriority: false,
    crossSourceLinks: [],
    lifecycleStatus: "REVIEW",
    archivedAt: null,
    currentFilterDecision: "REVIEW",
    currentFilterReasons: ["review"],
    currentFilterMissingFields: [],
    finderStatus: "REVIEW",
    finderVisible: true,
    ...overrides,
  };
}

// Task 4's required states: normal, REJECTED, "Przywróć do Flip Finder"
// (archived/stale lifecycle), external Facebook link, and the
// maximum-action combination (all conditional actions present at once).
const NORMAL_ID = "00000000-0000-4000-8000-000000000001";
const REJECTED_ID = "00000000-0000-4000-8000-000000000002";
const RESTORABLE_ID = "00000000-0000-4000-8000-000000000003";
const FACEBOOK_LINK_ID = "00000000-0000-4000-8000-000000000004";
const MAX_ACTIONS_ID = "00000000-0000-4000-8000-000000000005";

const listingsPayload = {
  listings: [
    makeListing({ listingId: NORMAL_ID, title: "Mieszkanie 3 pokoje, Widzew" }),
    makeListing({ listingId: REJECTED_ID, title: "Kawalerka, Bałuty", workflowStatus: "rejected", price: 280_000, area: 32, rooms: 1, pricePerM2: 8750, pricePerSqm: 8750 }),
    makeListing({ listingId: RESTORABLE_ID, title: "Dom, Górna", lifecycleStatus: "ARCHIVED", price: 620_000, area: 110, rooms: 4, pricePerM2: 5636, pricePerSqm: 5636 }),
    makeListing({ listingId: FACEBOOK_LINK_ID, title: "Mieszkanie, Śródmieście", originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325600/", price: 390_000, area: 48, rooms: 2, pricePerM2: 8125, pricePerSqm: 8125 }),
    makeListing({ listingId: MAX_ACTIONS_ID, title: "Kamienica, Polesie", workflowStatus: "rejected", lifecycleStatus: "ARCHIVED", readAt: now, isNew: false, originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325601/", price: 510_000, area: 88, rooms: 3, pricePerM2: 5795, pricePerSqm: 5795 }),
  ],
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

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "1280x800", width: 1280, height: 800, mobile: false },
  { name: "768x1024", width: 768, height: 1024, mobile: true },
  { name: "390x844", width: 390, height: 844, mobile: true },
];

const TOLERANCE = 1;

const ARTIFACT_DIR = path.join(os.tmpdir(), "claude-watcher-browser-verification");

function assertContains(parentLabel, parent, childLabel, child) {
  assert.ok(child.left >= parent.left - TOLERANCE, `${childLabel}.left (${child.left.toFixed(2)}) must be >= ${parentLabel}.left (${parent.left.toFixed(2)})`);
  assert.ok(child.right <= parent.right + TOLERANCE, `${childLabel}.right (${child.right.toFixed(2)}) must be <= ${parentLabel}.right (${parent.right.toFixed(2)}) — a child must never extend past its parent's content boundary`);
}

// Extracts the alpha channel from a computed border-color, whatever color
// function the browser reports it in (oklab(... / A), rgba(r, g, b, A), ...).
function borderAlpha(value) {
  const match = value.match(/\/\s*([\d.]+)\s*\)/) ?? value.match(/,\s*([\d.]+)\s*\)\s*$/);
  return match ? Number.parseFloat(match[1]) : null;
}

async function collectGeometry(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, width: r.width };
    };
    const appMain = document.querySelector("main.flex-1.overflow-y-auto");
    const pageContent = appMain.querySelector("main");
    const grid = pageContent.querySelector("div.grid.gap-5");
    const articles = [...document.querySelectorAll('article[id^="facebook-inbox-"]')];
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      appMain: rect(appMain),
      pageContent: rect(pageContent),
      grid: rect(grid),
      articles: articles.map((article) => {
        const statusPanel = article.querySelector(":scope > div.bg-card");
        const actionRow = article.querySelector("div.mt-3.flex-wrap.gap-2");
        const card = article.children[1];
        const buttons = [...actionRow.querySelectorAll("button, a")].map((button) => ({ label: (button.textContent || "").trim(), ...rect(button) }));
        return {
          listingId: article.id.replace("facebook-inbox-", ""),
          article: rect(article),
          statusPanel: rect(statusPanel),
          actionRow: rect(actionRow),
          card: rect(card),
          buttons,
        };
      }),
    };
  });
}

test("real Facebook Watcher card UI is geometrically responsive: every ancestor fits its parent, actions wrap and stay visible/clickable, at every required viewport", { timeout: 300_000 }, async (t) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let serverExited = false;
  const serverExit = new Promise((resolve) => server.once("exit", () => { serverExited = true; resolve(); }));
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  t.after(async () => {
    if (!server.killed && !serverExited) server.kill();
    await Promise.race([serverExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.equal(serverExited, true, `Next dev server must exit during test cleanup; output: ${output}`);
  });
  // Probe the real build-info route on this exact child-server port. A 404,
  // 500, HTML error page, or malformed body is not server readiness.
  await waitForServer(`http://127.0.0.1:${port}/api/build-info`, 90_000);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await browser.newPage();
  let patchMode = "success";
  const patchRequests = [];
  const pendingPatchReleases = [];
  const patchWaiters = [];
  let expectedPatchFailures = 0;
  const waitForPatchCount = (count, timeoutMs = 10_000) => {
    if (patchRequests.length >= count) return Promise.resolve(patchRequests[count - 1]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for PATCH ${count}; received ${patchRequests.length}`)), timeoutMs);
      patchWaiters.push({ count, resolve: (request) => { clearTimeout(timer); resolve(request); } });
    });
  };
  const notifyPatchWaiters = () => {
    for (let index = patchWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = patchWaiters[index];
      if (patchRequests.length >= waiter.count) {
        patchWaiters.splice(index, 1);
        waiter.resolve(patchRequests[waiter.count - 1]);
      }
    }
  };
  const resetPatchScenario = (mode) => {
    patchMode = mode;
    patchRequests.length = 0;
    pendingPatchReleases.splice(0).forEach((release) => release());
  };
  const releasePendingPatches = () => pendingPatchReleases.splice(0).forEach((release) => release());
  let resolveListingsRequest;
  const listingsRequest = new Promise((resolve) => { resolveListingsRequest = resolve; });
  const unexpectedConsoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => { if (message.type() === "error") unexpectedConsoleErrors.push(message.text()); });
  page.on("pageerror", (error) => unexpectedConsoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
  const responseErrors = [];
  page.on("response", (response) => {
    if (response.status() >= 400) responseErrors.push({ method: response.request().method(), url: response.url(), status: response.status() });
  });
  // Gallery-trace-volume mission: GalleryRequestButton (the component that
  // fires two automatic diagnostic POSTs per card on every render — see
  // gallery-request-trace.test.ts) is explicitly hidden for variant="watcher"
  // (facebook-watcher-panel.test.cjs already proves this at the source
  // level). Proven live in a real browser here: opening /facebook-watcher
  // must send zero requests to gallery/trace, regardless of listing count.
  let galleryTraceRequestCount = 0;
  await page.route("**/api/flip-finder/**/gallery/trace", (route) => {
    galleryTraceRequestCount += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });
  await page.route("**/api/facebook-watcher/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/facebook-watcher/listings" && route.request().method() === "GET") {
      resolveListingsRequest();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listingsPayload), status: 200 });
    }
    if (url.pathname.startsWith("/api/facebook-watcher/listings/") && route.request().method() === "PATCH") {
      const request = { body: JSON.parse(route.request().postData() || "{}"), status: null };
      request.response = new Promise((resolve) => { request.resolveResponse = resolve; });
      patchRequests.push(request);
      notifyPatchWaiters();
      if (patchMode === "delayed") await new Promise((resolve) => pendingPatchReleases.push(resolve));
      const status = patchMode === "failure" ? 500 : 200;
      if (status === 500) expectedPatchFailures += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(status === 500 ? { error: "Mock PATCH failed" } : { ok: true }), status });
      request.status = status;
      request.resolveResponse({ status });
      return;
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });
  await page.goto(`${baseUrl}/facebook-watcher`, { waitUntil: "domcontentloaded" });
  await listingsRequest;
  try {
    await page.locator('article[id^="facebook-inbox-"]').first().waitFor({ state: "visible", timeout: 45_000 });
  } catch (waitError) {
    // Under system-level resource contention the mocked listings fetch or the
    // dev server's own compile can stall well past a normal timeout, with no
    // relation to the component code under test. Surface enough to tell that
    // apart from a real regression instead of a bare "timeout exceeded".
    console.log(`Watcher listing did not render in time; server output: ${output}`);
    console.log(`Body text at timeout: ${await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => "<eval failed>")}`);
    throw waitError;
  }
  // Checked immediately, before any interaction below: opening the page
  // itself (rendering N listings, none clicked yet) must send zero
  // gallery/trace requests. A later click on a card's own pointer/click
  // capture wrapper (shared with Finder, used to debug the expand-to-dialog
  // mechanism) does independently write its own trace pair — a separate,
  // smaller, interaction-driven source this assertion is not about.
  assert.equal(galleryTraceRequestCount, 0, "opening /facebook-watcher must send zero requests to gallery/trace before any interaction — GalleryRequestButton (the only source of automatic render-time trace writes) is hidden for variant=\"watcher\"");

  const summary = {};

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Let layout settle after the resize before measuring.
    await page.waitForTimeout(150);

    const geometry = await collectGeometry(page);
    assert.equal(geometry.articles.length, 5, `${viewport.name}: exactly one <article> wrapper per fixture listing, never one around the whole grid`);

    // Document-level: never any horizontal overflow, at any viewport.
    assert.ok(geometry.documentScrollWidth <= geometry.documentClientWidth + TOLERANCE, `${viewport.name}: document must have no horizontal overflow (scrollWidth ${geometry.documentScrollWidth} vs clientWidth ${geometry.documentClientWidth})`);

    // General ancestor chain containment — required at every viewport, not just mobile.
    assertContains("viewport", { left: 0, right: geometry.viewportWidth }, "app <main>", geometry.appMain);
    assertContains("app <main>", geometry.appMain, "page content <main>", geometry.pageContent);
    assertContains("page content", geometry.pageContent, "grid", geometry.grid);

    for (const article of geometry.articles) {
      const label = article.listingId.slice(-1); // last digit distinguishes fixtures in messages
      assertContains("grid", geometry.grid, `article#${label}`, article.article);
      assertContains(`article#${label}`, article.article, `status panel#${label}`, article.statusPanel);
      assertContains(`article#${label}`, article.article, `card#${label}`, article.card);
      assertContains(`status panel#${label}`, article.statusPanel, `action row#${label}`, article.actionRow);
      for (const button of article.buttons) {
        assertContains(`status panel#${label}`, article.statusPanel, `button "${button.label}"#${label}`, button);
      }
    }

    // Mobile-specific: the whole point of this mission — nothing may render
    // wider than the actual visible viewport, and the false-positive
    // scrollWidth===clientWidth check from before is replaced by real
    // getBoundingClientRect containment against the viewport itself.
    if (viewport.mobile) {
      assert.ok(geometry.appMain.width <= viewport.width + TOLERANCE, `${viewport.name}: app main width (${geometry.appMain.width.toFixed(2)}) must fit the available viewport width (${viewport.width})`);
      assert.ok(geometry.pageContent.right <= viewport.width + TOLERANCE, `${viewport.name}: page content right edge (${geometry.pageContent.right.toFixed(2)}) must not exceed the viewport right edge (${viewport.width})`);
      for (const article of geometry.articles) {
        const label = article.listingId.slice(-1);
        assert.ok(article.article.right <= geometry.pageContent.right + TOLERANCE, `${viewport.name}: article#${label}.right (${article.article.right.toFixed(2)}) must not exceed page content's right edge (${geometry.pageContent.right.toFixed(2)})`);
        assert.ok(article.actionRow.right <= article.statusPanel.right + TOLERANCE, `${viewport.name}: article#${label} action row right (${article.actionRow.right.toFixed(2)}) must not exceed its status panel's right edge (${article.statusPanel.right.toFixed(2)})`);
        for (const button of article.buttons) {
          assert.ok(button.left >= -TOLERANCE && button.right <= viewport.width + TOLERANCE, `${viewport.name}: article#${label} button "${button.label}" (left ${button.left.toFixed(2)}, right ${button.right.toFixed(2)}) must be fully inside the visible viewport (0..${viewport.width})`);
        }
      }

      // Wrapping proof: the maximum-action listing (7 actions) cannot fit on
      // one line at mobile widths — at least two buttons must occupy
      // different `top` coordinates, proving the row actually wrapped
      // instead of merely being clipped by an oversized, unwrapped ancestor
      // (an ancestor clipping an oversized row would still report every
      // button on the SAME `top`, just with some pushed past the visible
      // edge — which the per-button viewport-containment check above would
      // already have caught).
      const maxActionsArticle = geometry.articles.find((article) => article.listingId === MAX_ACTIONS_ID);
      assert.ok(maxActionsArticle, `${viewport.name}: the maximum-action fixture listing must be present`);
      const distinctTops = new Set(maxActionsArticle.buttons.map((button) => Math.round(button.top)));
      assert.ok(distinctTops.size >= 2, `${viewport.name}: the maximum-action listing's 7 buttons must wrap onto at least 2 visibly distinct rows (found ${distinctTops.size}: ${[...distinctTops].join(", ")})`);
    }

    // Every fixture state's action set is actually rendered (Task 4).
    const byId = Object.fromEntries(geometry.articles.map((article) => [article.listingId, article.buttons.map((button) => button.label)]));
    assert.deepEqual(byId[NORMAL_ID].sort(), ["Analizuj", "Dodaj do CRM", "Interesująca", "Napraw galerię", "Odrzuć"].sort(), `${viewport.name}: normal listing action set`);
    assert.ok(byId[REJECTED_ID].includes("Przywróć") && !byId[REJECTED_ID].includes("Odrzuć"), `${viewport.name}: REJECTED listing must offer Przywróć, not Odrzuć`);
    assert.ok(byId[RESTORABLE_ID].includes("Przywróć do Flip Finder"), `${viewport.name}: ARCHIVED listing must offer Przywróć do Flip Finder`);
    assert.ok(byId[FACEBOOK_LINK_ID].includes("Facebook"), `${viewport.name}: listing with originalUrl must offer the external Facebook link`);
    assert.deepEqual(byId[MAX_ACTIONS_ID].sort(), ["Analizuj", "Dodaj do CRM", "Facebook", "Interesująca", "Napraw galerię", "Przywróć", "Przywróć do Flip Finder"].sort(), `${viewport.name}: maximum-action listing must render every conditional action at once`);

    // Stronger gold border mission (Task 2): 2px, one per listing, ~55% base
    // -> ~80% hover/focus, no second competing outline.
    const first = page.locator('article[id^="facebook-inbox-"]').first();
    const outerStyle = await first.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { borderWidth: computed.borderWidth, borderColor: computed.borderColor, overflowX: computed.overflowX };
    });
    await first.hover();
    await page.waitForTimeout(350); // exceed the 300ms transition-colors duration
    const hoverBorderColor = await first.evaluate((element) => getComputedStyle(element).borderColor);
    await page.mouse.move(0, 0);
    const innerPanelBorderWidth = await first.locator("> div").first().evaluate((element) => getComputedStyle(element).borderWidth);
    assert.equal(outerStyle.borderWidth, "2px", `${viewport.name}: outer gold border must be 2px`);
    assert.equal(innerPanelBorderWidth, "0px", `${viewport.name}: inner status panel must still carry no border of its own`);
    assert.notEqual(hoverBorderColor, outerStyle.borderColor, `${viewport.name}: hover must still step the border color`);
    const restAlpha = borderAlpha(outerStyle.borderColor);
    const hoverAlpha = borderAlpha(hoverBorderColor);
    assert.ok(restAlpha !== null && restAlpha >= 0.5 && restAlpha <= 0.6, `${viewport.name}: rest border opacity ${restAlpha} must be ~55% (${outerStyle.borderColor})`);
    assert.ok(hoverAlpha !== null && hoverAlpha >= 0.75 && hoverAlpha <= 0.85, `${viewport.name}: hover border opacity ${hoverAlpha} must be ~80% (${hoverBorderColor})`);

    summary[viewport.name] = {
      appMainWidth: geometry.appMain.width,
      pageContentWidth: geometry.pageContent.width,
      articleWidth: geometry.articles[0].article.width,
      statusPanelWidth: geometry.articles[0].statusPanel.width,
      actionRowWidth: geometry.articles[0].actionRow.width,
      maxButtonRight: Math.max(...geometry.articles.flatMap((article) => article.buttons.map((button) => button.right))),
      actionRowRows: new Set(geometry.articles.find((article) => article.listingId === MAX_ACTIONS_ID).buttons.map((button) => Math.round(button.top))).size,
      documentOverflow: geometry.documentScrollWidth - geometry.documentClientWidth,
    };

    await page.screenshot({ path: path.join(ARTIFACT_DIR, `watcher-${viewport.name}.png`), fullPage: true });
  }

  console.log(`WATCHER_GEOMETRY_SUMMARY=${JSON.stringify(summary, null, 2)}`);
  console.log(`Screenshots saved to: ${ARTIFACT_DIR}`);

  // Task 6: real interaction at the mobile viewport that exposed the bug.
  // Every assertion below uses the mocked local route, never Production.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const maxActionsArticleLocator = page.locator(`#facebook-inbox-${MAX_ACTIONS_ID}`);
  const interestingButton = maxActionsArticleLocator.getByRole("button", { name: "Interesująca" });
  assert.ok(await interestingButton.isVisible(), "the Interesująca button on the maximum-action listing must be visible at 390px");
  assert.equal(await interestingButton.isEnabled(), true, "the Interesująca button must be enabled before the click");
  resetPatchScenario("success");
  const successfulPatch = waitForPatchCount(1);
  await interestingButton.click();
  const successfulRequest = await successfulPatch;
  assert.deepEqual(successfulRequest.body, { status: "interesting" }, `clicking Interesująca at 390px must fire the exact workflow update; server output: ${output}`);
  assert.deepEqual(await successfulRequest.response, { status: 200 }, "the workflow PATCH must complete successfully");
  const maxStatusBadge = maxActionsArticleLocator.locator("span").filter({ hasText: "Interesująca" }).first();
  await maxStatusBadge.waitFor({ state: "visible", timeout: 5_000 });
  assert.ok(await maxActionsArticleLocator.getByRole("button", { name: "Odrzuć" }).isVisible(), "successful PATCH must render the new workflow action state");
  assert.equal(await maxActionsArticleLocator.getByRole("button", { name: "Przywróć", exact: true }).count(), 0, "successful PATCH must remove the stale rejected action");

  const facebookLink = maxActionsArticleLocator.getByRole("link", { name: "Facebook", exact: true });
  assert.ok(await facebookLink.isVisible(), "the external Facebook link on the maximum-action listing must be visible at 390px");
  assert.equal(await facebookLink.getAttribute("target"), "_blank", "the external Facebook link must still open in a new tab");

  const cardTitle = maxActionsArticleLocator.getByText("Kamienica, Polesie", { exact: true });
  await cardTitle.click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 });

  // A delayed real double-click must still create one mutation. The second
  // activation is attempted while the first PATCH is unresolved.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`#facebook-inbox-${NORMAL_ID}`).waitFor({ state: "visible", timeout: 10_000 });
  resetPatchScenario("delayed");
  const normalArticle = page.locator(`#facebook-inbox-${NORMAL_ID}`);
  const normalInteresting = normalArticle.getByRole("button", { name: "Interesująca" });
  const doublePatch = waitForPatchCount(1);
  await normalInteresting.dblclick({ delay: 0 });
  await doublePatch;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(patchRequests.length, 1, "rapid double-click must issue exactly one in-flight PATCH");
  releasePendingPatches();
  assert.deepEqual(await patchRequests[0].response, { status: 200 }, "the single double-click PATCH must succeed");
  await normalArticle.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 5_000 });

  // Keyboard activation is guarded by the same in-flight boundary.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`#facebook-inbox-${FACEBOOK_LINK_ID}`).waitFor({ state: "visible", timeout: 10_000 });
  resetPatchScenario("delayed");
  const keyboardArticle = page.locator(`#facebook-inbox-${FACEBOOK_LINK_ID}`);
  const keyboardInteresting = keyboardArticle.getByRole("button", { name: "Interesująca" });
  const keyboardPatch = waitForPatchCount(1);
  await keyboardInteresting.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await keyboardPatch;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(patchRequests.length, 1, "rapid keyboard activation must issue exactly one in-flight PATCH");
  releasePendingPatches();
  assert.deepEqual(await patchRequests[0].response, { status: 200 }, "the single keyboard PATCH must succeed");
  await keyboardArticle.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 5_000 });

  // A real 500 must leave the rendered workflow unchanged, show retryable
  // feedback, and permit a later successful retry.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`#facebook-inbox-${NORMAL_ID}`).waitFor({ state: "visible", timeout: 10_000 });
  resetPatchScenario("failure");
  const retryArticle = page.locator(`#facebook-inbox-${NORMAL_ID}`);
  const retryButton = retryArticle.getByRole("button", { name: "Interesująca" });
  const failedPatch = waitForPatchCount(1);
  await retryButton.click();
  const failedRequest = await failedPatch;
  assert.deepEqual(failedRequest.body, { status: "interesting" });
  assert.deepEqual(await failedRequest.response, { status: 500 }, "the failure scenario must receive an actual 500 response");
  await page.getByText("Mock PATCH failed", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await retryArticle.locator("span").filter({ hasText: "Interesująca" }).count(), 0, "failed PATCH must not render a false success state");
  patchMode = "success";
  const retryPatch = waitForPatchCount(2);
  await retryButton.click();
  await retryPatch;
  assert.deepEqual(await patchRequests[1].response, { status: 200 }, "retry PATCH must succeed");
  await retryArticle.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 5_000 });

  // Keyboard accessibility: a real Tab keypress (not a programmatic .focus(),
  // which Chromium does not treat as keyboard modality) must land visibly.
  await interestingButton.focus();
  await page.keyboard.press("Tab");
  const nextFocusOutline = await page.evaluate(() => {
    const element = document.activeElement;
    const computed = getComputedStyle(element);
    return { outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth, tag: element.tagName };
  });
  assert.notEqual(nextFocusOutline.outlineStyle, "none", `tabbing to the next control after Interesująca must show a visible focus outline, got ${JSON.stringify(nextFocusOutline)}`);

  const unexpectedNonPatchConsoleErrors = unexpectedConsoleErrors.filter((message) => !message.includes("status of 500"));
  assert.deepEqual(unexpectedNonPatchConsoleErrors, [], `browser page must not emit unexpected console errors: ${unexpectedNonPatchConsoleErrors.join(" | ")}`);
  assert.equal(unexpectedConsoleErrors.length, expectedPatchFailures, "the only browser console error may be the intentionally mocked failed PATCH");
  // Reloading between the isolated mutation scenarios intentionally aborts
  // background alert polling and in-flight font requests. Those are expected
  // navigation cancellations; any other failed request remains a failure.
  const unexpectedFailedRequests = failedRequests.filter((entry) => !(
    entry.includes("/api/alerts: net::ERR_ABORTED") ||
    entry.includes(".woff2: net::ERR_ABORTED") ||
    entry.includes("/__nextjs_font/") ||
    entry.includes("hot-update.json: net::ERR_ABORTED") ||
    entry.includes("?_rsc=") ||
    entry.includes("/_next/static/webpack/") ||
    entry.includes("/_next/static/css/")
  ));
  assert.deepEqual(unexpectedFailedRequests, [], `browser page must not have unexpected failed requests: ${unexpectedFailedRequests.join(" | ")}`);
  assert.equal(responseErrors.filter((entry) => entry.status >= 400).length, expectedPatchFailures, "the only HTTP error must be the intentionally mocked failed PATCH");
  assert.equal(expectedPatchFailures, 1, "the failed-PATCH scenario must exercise exactly one 500 response");

  await page.close();
});
