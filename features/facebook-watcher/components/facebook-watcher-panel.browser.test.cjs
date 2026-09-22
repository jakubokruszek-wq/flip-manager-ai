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
    makeListing({ listingId: MAX_ACTIONS_ID, title: "Kamienica, Polesie", workflowStatus: "rejected", lifecycleStatus: "ARCHIVED", originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325601/", price: 510_000, area: 88, rooms: 3, pricePerM2: 5795, pricePerSqm: 5795 }),
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
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  // 90s (not the 60s default): this page mounts a heavier tree up front
  // (KPI section, diagnostics, filter controls, five full listing cards)
  // than the simpler fixtures other .browser.test.cjs files boot against,
  // and the first request also pays for the route's cold webpack compile.
  await waitForServer(`http://127.0.0.1:${port}/facebook-watcher`, 90_000);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await browser.newPage();
  let workflowPatchBody = null;
  await page.route("**/api/facebook-watcher/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/facebook-watcher/listings" && route.request().method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify(listingsPayload), status: 200 });
    if (url.pathname.startsWith("/api/facebook-watcher/listings/") && route.request().method() === "PATCH") {
      workflowPatchBody = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });
  await page.goto(`${baseUrl}/facebook-watcher`, { waitUntil: "domcontentloaded" });
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

    // Gold border must remain exactly as before (Task 3): 1px, one per
    // listing, 20% base -> 45% hover/focus, no second competing outline.
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
    assert.equal(outerStyle.borderWidth, "1px", `${viewport.name}: outer gold border must remain 1px`);
    assert.equal(innerPanelBorderWidth, "0px", `${viewport.name}: inner status panel must still carry no border of its own`);
    assert.notEqual(hoverBorderColor, outerStyle.borderColor, `${viewport.name}: hover must still step the border from 20% to 45% gold opacity`);

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
  // fixture-safe (mocked PATCH), never a production write.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const maxActionsArticleLocator = page.locator(`#facebook-inbox-${MAX_ACTIONS_ID}`);
  const interestingButton = maxActionsArticleLocator.getByRole("button", { name: "Interesująca" });
  assert.ok(await interestingButton.isVisible(), "the Interesująca button on the maximum-action listing must be visible at 390px");
  workflowPatchBody = null;
  await interestingButton.click();
  await page.waitForFunction(() => true); // yield a tick
  await page.waitForTimeout(200);
  assert.deepEqual(workflowPatchBody, { status: "interesting" }, `clicking Interesująca at 390px must actually fire the workflow update; server output: ${output}`);

  const facebookLink = maxActionsArticleLocator.getByRole("link", { name: "Facebook", exact: true });
  assert.ok(await facebookLink.isVisible(), "the external Facebook link on the maximum-action listing must be visible at 390px");
  assert.equal(await facebookLink.getAttribute("target"), "_blank", "the external Facebook link must still open in a new tab");

  const cardTitle = maxActionsArticleLocator.getByText("Kamienica, Polesie", { exact: true });
  await cardTitle.click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 });

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

  await page.close();
});
