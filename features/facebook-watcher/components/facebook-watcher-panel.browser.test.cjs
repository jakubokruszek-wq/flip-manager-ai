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
const { ensureProductionBuild } = require("../../test-support/browser-auth.cjs");

const now = "2026-09-06T12:00:00.000Z";
const operatorSession = {
  access_token: "watcher-browser-test-access-token",
  refresh_token: "watcher-browser-test-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user: {
    id: "44444444-4444-4444-8444-444444444444",
    email: "operator@example.test",
    app_metadata: { role: "operator" },
    user_metadata: {},
    aud: "authenticated",
    created_at: now,
  },
};

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

function freshListingsPayload() {
  return {
    listings: [
      makeListing({ listingId: NORMAL_ID, title: "Mieszkanie 3 pokoje, Widzew" }),
      makeListing({ listingId: REJECTED_ID, title: "Kawalerka, Bałuty", workflowStatus: "rejected", price: 280_000, area: 32, rooms: 1, pricePerM2: 8750, pricePerSqm: 8750 }),
      makeListing({ listingId: RESTORABLE_ID, title: "Dom, Górna", lifecycleStatus: "ARCHIVED", price: 620_000, area: 110, rooms: 4, pricePerM2: 5636, pricePerSqm: 5636 }),
      makeListing({ listingId: FACEBOOK_LINK_ID, title: "Mieszkanie, Śródmieście", originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325600/", price: 390_000, area: 48, rooms: 2, pricePerM2: 8125, pricePerSqm: 8125 }),
      makeListing({ listingId: MAX_ACTIONS_ID, title: "Kamienica, Polesie", workflowStatus: "rejected", lifecycleStatus: "ARCHIVED", readAt: now, isNew: false, originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325601/", price: 510_000, area: 88, rooms: 3, pricePerM2: null, pricePerSqm: null }),
    ],
  };
}

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
  { name: "360x800", width: 360, height: 800, mobile: true },
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

/**
 * Lifecycle-race fix (an independent review reproduced, across 4 serial
 * runs of the previous single-shared-page design, both a listing-visibility
 * timeout after page.reload() and a genuine React console error --
 * "Can't perform a React state update on a component that hasn't mounted
 * yet" -- roughly 1 failure in 2 runs). The previous design reused ONE
 * Playwright Page across five interaction scenarios connected by
 * page.reload(), with route handlers and mutable counters (patchRequests,
 * pendingPatchReleases, a single top-level listingsRequest promise that was
 * only ever awaited once) captured in closures shared across every reload.
 * A full browser navigation does not guarantee the outgoing document's
 * pending microtasks/effects finish before the incoming document starts
 * mounting -- this app runs with React Strict Mode on by default (Next.js
 * App Router, unmodified here), which itself double-invokes effects on
 * every mount specifically to surface exactly this class of bug, and,
 * separately, nothing after the first page load ever re-awaited the
 * listings fetch actually completing before asserting DOM visibility.
 * Neither facebook-watcher-panel.tsx's own listings-fetch effect nor
 * AlertsBell's polling effect (the layout's only other async effect) was
 * found to be missing its mount-guard (`let active = true; ... if (active)
 * ...; return () => { active = false }`) on inspection -- both were already
 * correctly written. Confirmed empirically, not merely suspected: adding
 * extra Playwright event listeners (page.on("request")/("requestfinished"))
 * as a diagnostic measurably shifted timing and suppressed the race across
 * 12/12 further runs, and removing that instrumentation reproduced the
 * exact original timeout again on the very next run -- the signature of a
 * genuine cross-navigation timing race tied to this specific
 * shared-page/rapid-reload harness pattern, not a deterministic logic
 * defect in a named production callback.
 *
 * Fix: each of the five required scenarios below gets its own fresh
 * BrowserContext + Page, with its own route handlers and its own local
 * listings-request promise that is explicitly awaited (and asserted to have
 * fired exactly once) before any DOM assertion runs, closed before the next
 * scenario's context is created. No state of any kind is shared between
 * scenarios except the one already-running Next dev server and the shared
 * Chromium browser process (starting a fresh browser per scenario buys
 * nothing extra once contexts are already isolated, and would only slow the
 * suite down further).
 */
async function setupWatcherPage(browser, baseUrl, { patchMode: initialPatchMode = "success", listingsPayload = freshListingsPayload, photoResults = null } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);

  let patchMode = initialPatchMode;
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
  const setPatchMode = (mode) => { patchMode = mode; };
  const releasePendingPatches = () => pendingPatchReleases.splice(0).forEach((release) => release());

  let listingsRequestCount = 0;
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
  await page.route("**/api/alerts", route => route.fulfill({contentType:"application/json",body:JSON.stringify({alerts:[]}),status:200}));
  await page.route("**/api/facebook-watcher/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/facebook-watcher/duplicates/photos" && photoResults) return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({results:photoResults(JSON.parse(route.request().postData()||"{}").ids)})});
    if (url.pathname === "/api/facebook-watcher/listings" && route.request().method() === "GET") {
      listingsRequestCount += 1;
      resolveListingsRequest();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listingsPayload()), status: 200 });
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
  // Regression guard for the exact race this rearchitecture fixes: the
  // listings fetch for THIS page's own navigation must be explicitly
  // awaited, and awaited exactly once, before any DOM assertion — the
  // previous design's single top-level listingsRequest promise could only
  // ever resolve for the very first navigation, leaving every later
  // page.reload() with no synchronization point at all before its own
  // 10-second locator timeout. A harness that regressed to sharing one
  // listingsRequest promise across multiple navigations would fail this
  // assertion (count would be 0 on every navigation after the first) well
  // before it could ever reach a flaky DOM-visibility timeout.
  await listingsRequest;
  assert.equal(listingsRequestCount, 1, "this page's own navigation must trigger exactly one listings fetch, explicitly awaited before any DOM assertion");

  await page.locator('article[id^="facebook-inbox-"]').first().waitFor({ state: "visible", timeout: 15_000 });

  return {
    context,
    page,
    patchRequests,
    getListingsRequestCount: () => listingsRequestCount,
    waitForPatchCount,
    setPatchMode,
    releasePendingPatches,
    unexpectedConsoleErrors,
    failedRequests,
    responseErrors,
    galleryTraceRequestCount: () => galleryTraceRequestCount,
    getExpectedPatchFailures: () => expectedPatchFailures,
  };
}

function assertNoUnexpectedNoise(handle, { expectedPatchFailures = 0 } = {}) {
  const unexpectedNonPatchConsoleErrors = handle.unexpectedConsoleErrors.filter((message) => !message.includes("status of 500"));
  assert.deepEqual(unexpectedNonPatchConsoleErrors, [], `browser page must not emit unexpected console errors: ${unexpectedNonPatchConsoleErrors.join(" | ")}; HTTP responses: ${JSON.stringify(handle.responseErrors)}`);
  assert.equal(handle.unexpectedConsoleErrors.length, expectedPatchFailures, `the only browser console error may be an intentionally mocked failed PATCH; HTTP responses: ${JSON.stringify(handle.responseErrors)}; console: ${JSON.stringify(handle.unexpectedConsoleErrors)}`);
  const unexpectedFailedRequests = handle.failedRequests.filter((entry) => !(
    entry.includes("/api/alerts: net::ERR_ABORTED") ||
    entry.includes(".woff2: net::ERR_ABORTED") ||
    entry.includes("/__nextjs_font/") ||
    entry.includes("hot-update.json: net::ERR_ABORTED") ||
    entry.includes("?_rsc=") ||
    entry.includes("/_next/static/webpack/") ||
    entry.includes("/_next/static/css/")
  ));
  assert.deepEqual(unexpectedFailedRequests, [], `browser page must not have unexpected failed requests: ${unexpectedFailedRequests.join(" | ")}`);
  assert.equal(handle.responseErrors.filter((entry) => entry.status >= 400).length, expectedPatchFailures, "the only HTTP error may be an intentionally mocked failed PATCH");
  assert.equal(handle.getExpectedPatchFailures(), expectedPatchFailures, `exactly ${expectedPatchFailures} mocked 500 response(s) expected`);
}

test("Facebook Watcher browser suite: real card UI, workflow mutations and lifecycle isolation", { timeout: 420_000 }, async (t) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const port = await freePort();
  const authPort = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const authServer = require("node:http").createServer((request, response) => {
    if (request.url === "/auth/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(operatorSession.user));
      return;
    }
    if (request.url?.startsWith("/rest/v1/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    authServer.once("error", reject);
    authServer.listen(authPort, "127.0.0.1", resolve);
  });
  t.after(() => authServer.close());
  // Proven root cause (not "probably a reload race"): `next dev --webpack`'s
  // on-demand compilation and chunk-serving is measurably unreliable under
  // this suite's repeated-navigation load. A real serial run reproduced a
  // hard failure with the console error
  // 'Loading chunk app/layout failed... (timeout: .../_next/static/chunks/
  // app/layout.js)' — a genuine dev-server chunk-load timeout, not an
  // application defect. That failed chunk load is what left React in a
  // broken partial-mount state, which is what then produced "Can't perform
  // a React state update on a component that hasn't mounted yet" and,
  // separately, the original listing-visibility timeout after navigation.
  // Testing against the real production build (next build + next start)
  // removes on-demand webpack compilation and HMR entirely — chunks are
  // static, pre-built files served directly from disk — eliminating this
  // whole failure class at its source rather than papering over it with a
  // longer timeout, and is also the more faithful target for a
  // pre-production-release gate than the dev server.
  const browserEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(), NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "watcher-browser-test-publishable-key" };
  await ensureProductionBuild(nextBin, root, browserEnv);
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: browserEnv,
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
    assert.equal(serverExited, true, `Next production server must exit during test cleanup; output: ${output}`);
  });
  // Probe the real build-info route on this exact child-server port. A 404,
  // 500, HTML error page, or malformed body is not server readiness.
  await waitForServer(`http://127.0.0.1:${port}/api/build-info`, 90_000);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  // ---------------------------------------------------------------------
  // Scenario A: layout / borders / viewports. Read-only — no mutation.
  // ---------------------------------------------------------------------
  await t.test("A: card UI is geometrically responsive at every required viewport, with the correct gold border", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl);
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));

    // Checked immediately, before any interaction below: opening the page
    // itself (rendering N listings, none clicked yet) must send zero
    // gallery/trace requests. A later click on a card's own pointer/click
    // capture wrapper (shared with Finder, used to debug the expand-to-dialog
    // mechanism) does independently write its own trace pair — a separate,
    // smaller, interaction-driven source this assertion is not about.
    assert.equal(handle.galleryTraceRequestCount(), 0, "opening /facebook-watcher must send zero requests to gallery/trace before any interaction — GalleryRequestButton (the only source of automatic render-time trace writes) is hidden for variant=\"watcher\"");

    const summary = {};

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // Let layout settle after the resize before measuring.
      await page.waitForTimeout(150);

      if (viewport.width < 768) {
        const filters = page.getByText("Filtry", {exact:true});
        const detail = filters.locator("xpath=ancestor::details");
        if ((await detail.getAttribute("open")) === null) await filters.click();
        const fields = await detail.locator("input, select, button").evaluateAll(nodes => nodes.map(node => ({label:node.getAttribute("aria-label")??node.tagName,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));
        for (const field of fields) assert.ok(field.left >= -1 && field.right <= viewport.width+1, `${viewport.name}: filter ${field.label} stays inside the screen (${field.left}, ${field.right})`);
      }
      const tabs=page.getByRole("navigation",{name:"Status ofert Facebook"});
      await tabs.getByRole("button",{name:/^Wszystkie/}).click();
      await page.locator(`#facebook-inbox-${NORMAL_ID}`).waitFor({state:"visible"});
      const activeGeometry=await collectGeometry(page);
      assert.equal(activeGeometry.articles.length,3,"default inbox must hide manually rejected cards");
      await tabs.getByRole("button",{name:/^Odrzucone/}).click();
      await page.locator(`#facebook-inbox-${REJECTED_ID}`).waitFor({state:"visible"});
      const rejectedGeometry=await collectGeometry(page);
      assert.equal(rejectedGeometry.articles.length,2,"rejected cards remain available for restoration");
      const geometry={...activeGeometry,articles:[...activeGeometry.articles,...rejectedGeometry.articles]};
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
      assert.equal(byId[NORMAL_ID].length, 6, `${viewport.name}: normal listing renders every action including the disabled external-link state`);
      assert.ok(byId[NORMAL_ID].includes("Brak prawid\u0142owego linku do og\u0142oszenia"), `${viewport.name}: a missing listing URL must render the disabled-link message`);
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

    // Real interaction at the mobile viewport that exposed the original bug —
    // still on this same isolated page/context, since it exercises the same
    // rendered geometry this scenario already set up.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    // Explicit renderer-settle point, not a longer sleep: unlike B/C/D/E's
    // click on a freshly-loaded, idle page, this click follows 4 rounds of
    // resize + layout read + hover-transition + full-page screenshot on this
    // SAME page. A full-page screenshot drives Chromium through its own
    // internal viewport/emulation capture-and-restore cycle, and a stability
    // gate run reproduced two distinct failures isolated to exactly this
    // click (a slow re-render once, a click that produced zero PATCH
    // requests within 10s once) — never elsewhere, and never alongside any
    // console error, ruling out an application-level bug. Both disappeared
    // whenever unrelated diagnostic instrumentation was added, the same
    // suppression signature the dev-server chunk-load race showed — i.e. a
    // genuine renderer-catch-up race, not a deterministic defect. Waiting
    // for two chained animation frames guarantees Chromium has completed a
    // real paint cycle after that work before dispatching the click, which a
    // fixed sleep cannot guarantee under variable system load.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const maxActionsArticleLocator = page.locator(`#facebook-inbox-${MAX_ACTIONS_ID}`);
    const interestingButton = maxActionsArticleLocator.getByRole("button", { name: "Interesująca" });
    assert.ok(await interestingButton.isVisible(), "the Interesująca button on the maximum-action listing must be visible at 390px");
    assert.equal(await interestingButton.isEnabled(), true, "the Interesująca button must be enabled before the click");
    const successfulPatch = handle.waitForPatchCount(1);
    await interestingButton.click();
    const successfulRequest = await successfulPatch;
    assert.deepEqual(successfulRequest.body, { status: "interesting" }, `clicking Interesująca at 390px must fire the exact workflow update; server output: ${output}`);
    assert.deepEqual(await successfulRequest.response, { status: 200 }, "the workflow PATCH must complete successfully");
    await maxActionsArticleLocator.waitFor({state:"hidden"});
    await page.getByRole("navigation",{name:"Status ofert Facebook"}).getByRole("button",{name:/^Okazje/}).click();
    const maxStatusBadge = maxActionsArticleLocator.locator("span").filter({ hasText: "Interesująca" }).first();
    // Under the full serial browser suite React may commit the successful
    // workflow response after Chromium has already observed the PATCH. Keep
    // this assertion bounded, but allow the same local-render window used by
    // the navigation gates so the test does not turn renderer contention into
    // a false failure.
    await maxStatusBadge.waitFor({ state: "visible", timeout: 15_000 });
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

    assertNoUnexpectedNoise(handle, { expectedPatchFailures: 0 });
  });

  // ---------------------------------------------------------------------
  // Scenario B: successful "Interesująca" PATCH on a fresh page.
  // ---------------------------------------------------------------------
  await t.test("B: clicking Interesująca fires exactly one PATCH {status:\"interesting\"} and visibly updates the card on 200", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl);
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));

    const article = page.locator(`#facebook-inbox-${NORMAL_ID}`);
    const interestingButton = article.getByRole("button", { name: "Interesująca" });
    await interestingButton.waitFor({ state: "visible", timeout: 15_000 });
    await interestingButton.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await interestingButton.waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await interestingButton.isEnabled(), true, "the Interesująca button must be enabled before the click");
    const successfulPatch = handle.waitForPatchCount(1, 20_000);
    await interestingButton.click({ timeout: 15_000 });
    const successfulRequest = await successfulPatch;
    assert.equal(handle.patchRequests.length, 1, "exactly one PATCH must be sent for a single click");
    assert.deepEqual(successfulRequest.body, { status: "interesting" });
    assert.deepEqual(await successfulRequest.response, { status: 200 });
    await article.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 15_000 });
    assert.ok(await article.getByRole("button", { name: "Odrzuć" }).isVisible(), "successful PATCH must render the new workflow action state");

    assertNoUnexpectedNoise(handle, { expectedPatchFailures: 0 });
  });

  // ---------------------------------------------------------------------
  // Scenario C: rapid mouse double-click must issue exactly one PATCH.
  // ---------------------------------------------------------------------
  await t.test("C: a rapid double-click issues exactly one in-flight PATCH, delayed until the second activation attempt", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl, { patchMode: "delayed" });
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));

    assert.equal(handle.patchRequests.length, 0, "a freshly isolated page must start with zero PATCH history from any prior scenario");
    const article = page.locator(`#facebook-inbox-${NORMAL_ID}`);
    const interestingButton = article.getByRole("button", { name: "Interesująca" });
    const firstPatch = handle.waitForPatchCount(1);
    await interestingButton.dblclick({ delay: 0 });
    await firstPatch;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handle.patchRequests.length, 1, "rapid double-click must issue exactly one in-flight PATCH — the first response was still held open ('delayed' mode) when the second activation was attempted");
    handle.releasePendingPatches();
    assert.deepEqual(await handle.patchRequests[0].response, { status: 200 }, "the single double-click PATCH must succeed");
    await article.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 15_000 });

    assertNoUnexpectedNoise(handle, { expectedPatchFailures: 0 });
  });

  // ---------------------------------------------------------------------
  // Scenario D: rapid keyboard double-activation must issue exactly one PATCH.
  // ---------------------------------------------------------------------
  await t.test("D: rapid keyboard double-activation (Enter, Enter) issues exactly one in-flight PATCH", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl, { patchMode: "delayed" });
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));

    assert.equal(handle.patchRequests.length, 0, "a freshly isolated page must start with zero PATCH history from any prior scenario");
    const article = page.locator(`#facebook-inbox-${FACEBOOK_LINK_ID}`);
    const interestingButton = article.getByRole("button", { name: "Interesująca" });
    const firstPatch = handle.waitForPatchCount(1);
    await interestingButton.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await firstPatch;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(handle.patchRequests.length, 1, "rapid keyboard activation must issue exactly one in-flight PATCH — the first response was still held open ('delayed' mode) when the second activation was attempted");
    handle.releasePendingPatches();
    assert.deepEqual(await handle.patchRequests[0].response, { status: 200 }, "the single keyboard PATCH must succeed");
    await article.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 15_000 });

    assertNoUnexpectedNoise(handle, { expectedPatchFailures: 0 });
  });

  // ---------------------------------------------------------------------
  // Scenario E: a real 500 leaves the UI unchanged and shows visible error
  // feedback; a subsequent retry PATCH's own 200 is what changes the UI.
  // ---------------------------------------------------------------------
  await t.test("E: a failed PATCH shows visible error feedback with no false success state, and only a successful retry changes the UI", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl, { patchMode: "failure" });
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));

    const article = page.locator(`#facebook-inbox-${NORMAL_ID}`);
    const interestingButton = article.getByRole("button", { name: "Interesująca" });
    const failedPatch = handle.waitForPatchCount(1);
    await interestingButton.click();
    const failedRequest = await failedPatch;
    assert.deepEqual(failedRequest.body, { status: "interesting" });
    assert.deepEqual(await failedRequest.response, { status: 500 }, "the failure scenario must receive an actual 500 response");
    await page.getByText("Mock PATCH failed", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await article.locator("span").filter({ hasText: "Interesująca" }).count(), 0, "failed PATCH must not render a false success state");

    handle.setPatchMode("success");
    const retryPatch = handle.waitForPatchCount(2);
    await interestingButton.click();
    await retryPatch;
    assert.equal(handle.patchRequests.length, 2, "retry must send exactly one additional PATCH");
    assert.deepEqual(await handle.patchRequests[1].response, { status: 200 }, "retry PATCH must succeed");
    await article.locator("span").filter({ hasText: "Interesująca" }).first().waitFor({ state: "visible", timeout: 15_000 });

    assertNoUnexpectedNoise(handle, { expectedPatchFailures: 1 });
    assert.equal(handle.getExpectedPatchFailures(), 1, "the failed-PATCH scenario must exercise exactly one 500 response");
  });
  await t.test("F: mobile ranges save, survive reload and clear without horizontal overflow", async (t) => {
    const handle = await setupWatcherPage(browser, baseUrl,{listingsPayload:()=>({listings:freshListingsPayload().listings.map(item=>item.listingId===MAX_ACTIONS_ID?{...item,workflowStatus:"review"}:item)})});
    const { page } = handle;
    t.after(() => Promise.all([page.close(), handle.context.close()]));
    await page.setViewportSize({width:360,height:800});
    const openFilters=async()=>{await page.getByText("Filtry",{exact:true}).click();return page.locator("details[open]").filter({has:page.getByText("Filtry",{exact:true})});};
    let controls=await openFilters();
    await controls.getByLabel("Cena minimalna (PLN)",{exact:true}).fill("250000");
    await controls.getByLabel("Cena maksymalna (PLN)",{exact:true}).fill("550000");
    await controls.getByLabel("Powierzchnia min. (m²)",{exact:true}).fill("35.5");
    await controls.getByLabel("Powierzchnia maks. (m²)",{exact:true}).fill("65");
    await controls.getByRole("checkbox",{name:"2",exact:true}).check();
    await controls.getByRole("checkbox",{name:"3",exact:true}).check();
    await page.getByRole("button",{name:"Zapisz filtry",exact:true}).click();
    await page.getByText("Filtry zapisane na tym urządzeniu.",{exact:true}).waitFor();
    await page.reload({waitUntil:"networkidle"});
    controls=await openFilters();
    assert.equal(await controls.getByLabel("Cena minimalna (PLN)",{exact:true}).inputValue(),"250000");
    assert.equal(await controls.getByLabel("Powierzchnia min. (m²)",{exact:true}).inputValue(),"35.5");
    assert.equal(await controls.getByLabel("Powierzchnia maks. (m²)",{exact:true}).inputValue(),"65");
    assert.equal(await controls.getByRole("checkbox",{name:"2",exact:true}).isChecked(),true);
    assert.equal(await controls.getByRole("checkbox",{name:"3",exact:true}).isChecked(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await controls.getByLabel("Powierzchnia min. (m²)",{exact:true}).fill("90");
    await page.getByRole("alert").filter({hasText:"Powierzchnia:"}).waitFor();
    assert.equal(await page.getByRole("button",{name:"Zapisz filtry",exact:true}).isDisabled(),true);
    await controls.getByRole("button",{name:"Wyczyść filtry",exact:true}).click();
    await page.getByRole("button",{name:"Zapisz filtry",exact:true}).click();
    await page.reload({waitUntil:"networkidle"});
    controls=await openFilters();
    assert.equal(await controls.getByLabel("Cena minimalna (PLN)",{exact:true}).inputValue(),"");
    assert.equal(await controls.getByRole("checkbox",{name:"2",exact:true}).isChecked(),false);
    await controls.getByLabel("Maks. cena za m² (PLN)",{exact:true}).fill("7000");
    await page.locator(`#facebook-inbox-${NORMAL_ID}`).waitFor({state:"hidden"});
    await page.locator(`#facebook-inbox-${MAX_ACTIONS_ID}`).waitFor({state:"visible"});
    assert.equal(await page.locator(`#facebook-inbox-${FACEBOOK_LINK_ID}`).count(),0,"a known price above the limit is excluded while the missing value remains");
    assertNoUnexpectedNoise(handle);
  });

  await t.test("G: three cross-group reposts render one card with duplicate count and each publication link",async(t)=>{
    const description="Sprzedam bezpośrednio mieszkanie przy ulicy Przykładowej na Widzewie w Łodzi. Trzy ustawne pokoje, oddzielna kuchnia i balkon. Lokal posiada piwnicę, wymienione instalacje oraz wyposażenie widoczne na zdjęciach. Zapraszam do kontaktu i obejrzenia nieruchomości.";
    const ids=[NORMAL_ID,"00000000-0000-4000-8000-000000000006","00000000-0000-4000-8000-000000000007"];
    const handle=await setupWatcherPage(browser,baseUrl,{listingsPayload:()=>({listings:ids.map((listingId,i)=>makeListing({listingId,description,groupName:`Grupa ${i+1}`,sourcePostUrl:`https://www.facebook.com/groups/group${i+1}/posts/123456789/`}))})});
    const {page}=handle;
    t.after(()=>Promise.all([page.close(),handle.context.close()]));
    await page.setViewportSize({width:360,height:800});
    const representative=page.locator(`#facebook-inbox-${NORMAL_ID}`);
    await representative.waitFor();
    assert.equal(await page.locator('article[id^="facebook-inbox-"]').count(),1);
    await representative.getByText("Duplikaty: 2 · Powiązane publikacje (3)",{exact:true}).click();
    for(let i=0;i<3;i++)assert.equal(await representative.locator(`a[href="https://www.facebook.com/groups/group${i+1}/posts/123456789/"]`).count()>=1,true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    assertNoUnexpectedNoise(handle);
  });

  await t.test("H: real Android snapshots with no description render as possible duplicates with every source link",async(t)=>{
    const ids=[NORMAL_ID,"00000000-0000-4000-8000-000000000006","00000000-0000-4000-8000-000000000007"];
    const handle=await setupWatcherPage(browser,baseUrl,{listingsPayload:()=>({listings:ids.map((listingId,i)=>makeListing({listingId,title:"Oferta z Facebooka",price:699000,area:75,pricePerSqm:9320,description:null,city:null,district:null,neighborhood:null,rooms:null,floor:null,street:"Dębowej",groupName:null,images:[],sourcePostUrl:`https://www.facebook.com/groups/group${i+1}/posts/123456789/`}))})});
    const {page}=handle;
    t.after(()=>Promise.all([page.close(),handle.context.close()]));
    await page.setViewportSize({width:360,height:800});
    const representative=page.locator(`#facebook-inbox-${NORMAL_ID}`);
    await representative.waitFor();
    assert.equal(await page.locator('article[id^="facebook-inbox-"]').count(),1);
    await representative.getByText("Możliwe duplikaty: 2 · Powiązane publikacje (3)",{exact:true}).click();
    for(let i=0;i<3;i++)assert.equal(await representative.locator(`a[href="https://www.facebook.com/groups/group${i+1}/posts/123456789/"]`).count()>=1,true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    assertNoUnexpectedNoise(handle);
  });

  await t.test("I: refresh and returning online update grouped counters without restarting the phone app",async(t)=>{
    let records=[makeListing({listingId:NORMAL_ID})];
    const handle=await setupWatcherPage(browser,baseUrl,{listingsPayload:()=>({listings:records})});
    const {page}=handle;
    t.after(()=>Promise.all([page.close(),handle.context.close()]));
    const ids=[NORMAL_ID,"00000000-0000-4000-8000-000000000006","00000000-0000-4000-8000-000000000007"];
    records=ids.map((listingId,i)=>makeListing({listingId,price:699000,area:75,description:null,city:null,rooms:null,street:"Dębowej",images:[],sourcePostUrl:`https://www.facebook.com/groups/group${i+1}/posts/123456789/`}));
    await page.getByRole("button",{name:"Odśwież oferty",exact:true}).click();
    await page.getByText("Oferty: 1 · Publikacje: 3 · Powtórki: 2",{exact:true}).waitFor();
    assert.match(await page.getByRole("navigation",{name:"Status ofert Facebook"}).getByRole("button",{name:/Wszystkie/}).innerText(),/Wszystkie\s*1/u);
    await page.getByText("Ostatnie pobranie:",{exact:false}).waitFor();
    records=[...records,makeListing({listingId:FACEBOOK_LINK_ID,price:400000,area:52})];
    const before=handle.getListingsRequestCount();
    await page.evaluate(()=>{window.dispatchEvent(new Event("online"));window.dispatchEvent(new Event("focus"));});
    await page.getByText("Oferty: 2 · Publikacje: 4 · Powtórki: 2",{exact:true}).waitFor();
    assert.equal(handle.getListingsRequestCount(),before+1,"simultaneous foreground/network events share one refresh");
    assert.equal(await page.locator('article[id^="facebook-inbox-"]').count(),2);
    assertNoUnexpectedNoise(handle);
  });

  await t.test("J: verified pair with no location renders one card and keeps both source links",async(t)=>{
    const ids=[NORMAL_ID,"00000000-0000-4000-8000-000000000006"];
    const handle=await setupWatcherPage(browser,baseUrl,{listingsPayload:()=>({listings:ids.map((listingId,i)=>makeListing({listingId,price:299000,area:60,rooms:3,description:null,city:null,district:null,neighborhood:null,street:null,images:[],confirmedDuplicateGroupId:"verified-pair",sourcePostUrl:`https://www.facebook.com/groups/group${i+1}/posts/123456789/`}))})});
    const {page}=handle;t.after(()=>Promise.all([page.close(),handle.context.close()]));
    await page.getByText("Duplikaty: 1 · Powiązane publikacje (2)",{exact:true}).click();
    assert.equal(await page.locator('article[id^="facebook-inbox-"]').count(),1);
    for(let i=0;i<2;i++)assert.equal(await page.locator(`a[href="https://www.facebook.com/groups/group${i+1}/posts/123456789/"]`).count()>=1,true);
    assertNoUnexpectedNoise(handle);
  });

  await t.test("K: rejecting a card removes it immediately and restoring moves it back to the main inbox",async(t)=>{
    const handle=await setupWatcherPage(browser,baseUrl);const {page}=handle;
    t.after(()=>Promise.all([page.close(),handle.context.close()]));
    const tabs=page.getByRole("navigation",{name:"Status ofert Facebook"});
    const card=page.locator(`#facebook-inbox-${NORMAL_ID}`);
    await card.getByRole("button",{name:"Odrzuć",exact:true}).click();
    await card.waitFor({state:"hidden"});
    assert.deepEqual(handle.patchRequests[0].body,{status:"rejected"});
    await tabs.getByRole("button",{name:/^Odrzucone/}).click();await card.waitFor({state:"visible"});
    await card.getByRole("button",{name:"Przywróć",exact:true}).click();await card.waitFor({state:"hidden"});
    await tabs.getByRole("button",{name:/^Wszystkie/}).click();await card.waitFor({state:"visible"});
    assert.deepEqual(handle.patchRequests[1].body,{status:"re…5641 tokens truncated…</div><h1 className="font-heading text-3xl font-bold tracking-tight">Facebook Watcher / Inbox</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Jedno miejsce do przeglądania, analizowania i przekazywania ofert Facebooka do CRM.</p></div><div className="flex flex-wrap gap-2"><Button nativeButton={false} variant="outline" render={<Link href="/facebook-watcher/groups"/>} className="min-h-11">Obserwowane grupy</Button><Button nativeButton={false} render={<Link href="/properties/new"/>} className="min-h-11"><Plus className="size-4"/>Dodaj post z Facebooka</Button><Button disabled={historyClearing} variant="outline" className="min-h-11" onClick={()=>void clearWatcherHistory()}>{historyClearing?"Czyszczenie…":"Wyczyść historię Watchera"}</Button></div></header>
    <section className="flex flex-wrap items-end gap-3 rounded-xl border p-3" aria-label="Czyszczenie według daty zapisu">
      <label className="text-sm">Usuń oferty zapisane przed<Input aria-label="Data zapisu oferty" type="date" value={cleanupDate} max={new Date().toISOString().slice(0,10)} onChange={event=>setCleanupDate(event.target.value)} disabled={historyClearing}/></label>
      <Button variant="outline" disabled={!cleanupDate||historyClearing} onClick={()=>void cleanupSavedBefore()}>Podgląd i usuń starsze</Button>
      <p className="w-full text-xs text-muted-foreground">Wiek według daty zapisania w bazie, nie publikacji ani ostatniego odczytu. Najpierw zobaczysz liczbę ofert. CRM i Deal Room pozostają chronione.</p>
    </section>
    <nav aria-label="Status ofert Facebook" className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">{TABS.map(item=><button aria-pressed={tab===item.value} className={`min-h-11 shrink-0 snap-start rounded-xl border px-4 text-sm font-semibold ${tab===item.value?"border-gold/40 bg-gold/15 text-gold":"border-border bg-card text-muted-foreground hover:text-foreground"}`} key={item.value} onClick={()=>setTab(item.value)}>{item.label}<span className="ml-2 rounded-full bg-black/15 px-2 py-0.5 text-xs">{item.value==="all"?groupedListings.filter(value=>value.workflowStatus!=="rejected").length:groupedListings.filter(value=>value.workflowStatus===item.value).length}</span></button>)}</nav>
    <section className="min-w-0 space-y-4" aria-label="Wyszukiwanie ofert Facebook"><div className="min-w-0 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_240px_auto]"><label className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground"/><Input aria-label="Szukaj ofert Facebook" className="h-11 pl-10" placeholder="Szukaj: tytuł, opis, ulica, osiedle, grupa" value={filters.query} onChange={event=>setFilters(current=>({...current,query:event.target.value}))}/></label><select aria-label="Sortowanie" className="h-11 min-w-0 w-full rounded-xl border border-input bg-background px-3 text-sm" value={sort} onChange={event=>setSort(event.target.value as FacebookInboxSort)}><option value="newest">Najnowsze</option><option value="opportunity">Najwyższy Opportunity Score</option><option value="flip">Najwyższy Flip Score</option><option value="price_per_sqm">Najniższa cena/m²</option><option value="price">Najniższa cena</option><option value="profit">Największy potencjalny zysk</option></select><details className="relative min-w-0 md:hidden"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-xl border bg-card px-4 text-sm font-semibold"><Filter className="size-4"/>Filtry</summary><div className="mt-2 min-w-0 max-w-full rounded-xl border bg-card p-4"><FilterControls filters={filters} listings={listings} setFilters={setFilters}/></div></details></div><div className="hidden rounded-2xl border border-border/70 bg-card p-4 md:block"><FilterControls filters={filters} listings={listings} setFilters={setFilters}/></div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="button" disabled={Boolean(filterError)} onClick={saveFilters}>Zapisz filtry</Button>
        <p className="text-xs text-muted-foreground">Zapis na tym urządzeniu. Po powrocie i odświeżeniu przywracamy zapisany zakres.</p>
        <Link className="text-sm underline" href="/flip-finder/filters">Zarządzaj filtrami skanowania w Finderze</Link>
      </div>
      {filterError?<p role="alert" className="text-sm text-destructive">{filterError}</p>:null}
      <div className="text-sm text-muted-foreground">Wyniki: <strong className="text-foreground">{visible.length}</strong></div>
      {visible.some(item=>(item.relatedPosts?.length??0)>1)?<p className="text-xs text-muted-foreground">Po zgrupowaniu: {visible.length} kart · {visible.reduce((total,item)=>total+(item.relatedPosts?.length??1),0)} publikacji. „Możliwe duplikaty” oznaczają zgodne parametry bez potwierdzenia zdjęciem lub pełnym opisem. Każdy post pozostaje dostępny w „Powiązane publikacje”.</p>:null}
      {error?<p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error}</p>:null}{loading?<p className="py-12 text-center text-sm text-muted-foreground">Ładowanie Inboxu…</p>:null}
      {!loading&&visible.length===0?<div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">Brak ofert spełniających wybrane kryteria.</div>:null}
      {photoComparisonProgress?<p role="status" className="text-xs text-muted-foreground">{photoComparisonProgress}</p>:null}<div className="grid gap-5 xl:grid-cols-2">{visible.map(item=><InboxItem addToCrm={addToCrm} registerAnalysisButton={registerAnalysisButton} busy={busyId===item.listingId} item={item} key={item.listingId} onAnalyze={openAnalysis} onRepairGallery={repairGallery} onRestoreToFinder={restoreToFinder} updateWorkflow={guardedUpdateWorkflow}/>)}</div>
    </section>
    {toast?<div aria-live="polite" className={`fixed inset-x-0 bottom-5 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-xl border px-4 py-3 text-sm font-medium shadow-xl ${toast.tone==="success"?"border-emerald-500/30 bg-emerald-500/10 text-emerald-600":"border-destructive/30 bg-destructive/10 text-destructive"}`}>{toast.text}</div>:null}
  </main>;
}

function InboxItem({item,busy,updateWorkflow,addToCrm,onAnalyze,onRepairGallery,onRestoreToFinder,registerAnalysisButton}:{item:FacebookWatcherListing;busy:boolean;updateWorkflow:(item:FacebookWatcherListing,change:{status?:FacebookWorkflowStatus;markRead?:boolean;crmPropertyId?:string})=>Promise<void>;addToCrm:(item:FacebookWatcherListing)=>Promise<void>;onAnalyze:(id:string)=>void;onRepairGallery:(item:FacebookWatcherListing)=>Promise<void>;onRestoreToFinder:(item:FacebookWatcherListing)=>Promise<void>;registerAnalysisButton:(id:string,button:HTMLButtonElement|null)=>void}) { const result=toFilterResult(item); const listingUrl=resolveListingUrl({source:"facebook",sourcePostUrl:item.sourcePostUrl,originalUrl:item.originalUrl}); const suspect=priceSuspect(item); const priceExplanation=item.priceQuality?facebookPriceReviewExplanation(item.priceQuality,item.price):null; const finderStatus=item.finderStatus??"HISTORICAL"; const presentation=resolveListingStatusPresentation({finderStatus,lifecycleStatus:facebookLifecycleStatus(item.lifecycleStatus)}); const currentLabel=item.currentFilterDecision&&item.currentFilterDecision!==finderStatus?` · teraz ${item.currentFilterDecision}`:""; return <article className="space-y-2 overflow-hidden rounded-[1.125rem] !border-2 !border-gold/55 transition-colors duration-300 hover:!border-gold/80 focus-within:!border-gold/80" id={`facebook-inbox-${item.listingId}`}><div className="bg-card px-3 py-3"><div className="flex flex-wrap items-center gap-2"><WorkflowBadge status={item.workflowStatus}/>{item.highPriority?<Badge text="🔥 Wysoki priorytet" tone="fire"/>:null}{suspect?<Badge text="Cena do weryfikacji"/>:null}{item.locationState==="AMBIGUOUS"||item.locationState==="MISSING"?<Badge text="Niepewna lokalizacja"/>:null}{item.availability&&item.availability!=="ACTIVE"?<Badge text={item.availability==="SOLD"?"Sprzedane":item.availability==="RESERVED"?"Zarezerwowane":"Nieaktualne"}/>:null}{item.freshness==="STALE"?<Badge text="Nieaktualny wpis"/>:null}{item.sellerType==="private"?<Badge text="Prywatny właściciel"/>:null}{item.condition==="renovation"?<Badge text="Do remontu"/>:null}{item.flags.filter(flag=>/bez pośred|pilne/i.test(flag)).slice(0,2).map(flag=><Badge key={flag} text={flag}/>)}</div>{priceExplanation?<p className="mt-2 text-xs text-muted-foreground">{priceExplanation}</p>:null}<div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><span>Publikacja: {dateTime(item.publishedAt)}</span><span>Import: {dateTime(item.importedAt)}</span><span>Grupa: {item.groupName??"Facebook"}</span><span>{presentation.mode==="distinct"?<>Finder: <strong className="text-foreground">{presentation.finderLabel}</strong>{currentLabel} · cykl życia: <strong className="text-foreground">{presentation.lifecycleLabel}</strong></>:<>Status: <strong className="text-foreground">{presentation.label}</strong>{currentLabel}</>}</span><span>Opportunity Score: <strong className="text-gold">{item.opportunityScore}</strong> · Flip Score: <strong className="text-foreground">{item.flipScore}</strong></span></div>{item.crossSourceLinks.length?<div className="mt-2 flex flex-wrap gap-2">{item.crossSourceLinks.map(link=><a className="text-xs font-semibold text-sky-400 hover:underline" href={link.url} key={link.url} rel="noopener noreferrer" target="_blank">Znaleziona też na {sourceName(link.source)} ↗</a>)}</div>:null}<div className="mt-3 flex flex-wrap gap-2"><Action buttonRef={button=>registerAnalysisButton(item.listingId,button)} disabled={busy} label="Analizuj" onClick={()=>onAnalyze(item.listingId)}/><Action disabled={busy} label="Napraw galerię" onClick={()=>void onRepairGallery(item)}/>{item.lifecycleStatus==="ARCHIVED"||item.lifecycleStatus==="STALE"?<Action disabled={busy} label="Przywróć do Flip Finder" onClick={()=>void onRestoreToFinder(item)}/>:null}<Action disabled={busy} label="Interesująca" onClick={()=>void updateWorkflow(item,{status:"interesting"})}/><Action disabled={busy} label="Dodaj do CRM" onClick={()=>void addToCrm(item)}/>{item.workflowStatus==="rejected"?<Action disabled={busy} icon={<Undo2 className="size-3.5"/>} label="Przywróć" onClick={()=>void updateWorkflow(item,{status:"review"})}/>:<Action disabled={busy} icon={<XCircle className="size-3.5"/>} label="Odrzuć" onClick={()=>void updateWorkflow(item,{status:"rejected"})}/>} {listingUrl?<a className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold" href={listingUrl} rel="noopener noreferrer" target="_blank"><ExternalLink className="size-3.5"/>Facebook</a>:<button className="min-h-11 shrink-0 rounded-lg border px-3 text-xs font-semibold text-muted-foreground" disabled type="button">Brak prawidłowego linku do ogłoszenia</button>}</div></div>{item.relatedPosts&&item.relatedPosts.length>1?<details className="min-w-0 px-4 pb-3"><summary className="cursor-pointer text-sm">{item.relatedPostMatch === "possible" ? "Możliwe duplikaty" : "Duplikaty"}: {item.relatedPosts.length - 1} · Powiązane publikacje ({item.relatedPosts.length})</summary><ul className="mt-2 space-y-2 text-sm">{item.relatedPosts.map((post,index)=><li key={post.listingId}>{post.url?<a className="break-words underline" href={post.url} target="_blank" rel="noopener noreferrer">{post.groupName??`Publikacja ${index+1}`}</a>:"Brak linku do posta"}</li>)}</ul></details>:null}<ExpandableListingCard averagePricePerSqm={null} hideLifecycleBadge={presentation.mode!=="distinct"} marketType={item.marketType} onCrmImported={propertyId=>void updateWorkflow(item,{status:"crm",crmPropertyId:propertyId})} onOpen={()=>{if(!item.readAt)void updateWorkflow(item,{markRead:true});}} result={result} variant="watcher"/></article>; }

function FilterControls({filters,listings,setFilters}:{filters:FacebookInboxFilters;listings:FacebookWatcherListing[];setFilters:React.Dispatch<React.SetStateAction<FacebookInboxFilters>>}) {
  const update=<K extends keyof FacebookInboxFilters>(key:K,value:FacebookInboxFilters[K])=>setFilters(current=>({...current,[key]:value}));
  const options=(key:"neighborhood"|"district"|"groupName")=>[...new Set([...listings.map(item=>item[key]),key==="groupName"?filters.group:filters[key]].filter((value):value is string=>Boolean(value)))].sort((a,b)=>a.localeCompare(b,"pl"));
  return <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
    <Select label="Osiedle" value={filters.neighborhood} onChange={value=>update("neighborhood",value)} options={options("neighborhood")}/>
    <Select label="Dzielnica" value={filters.district} onChange={value=>update("district",value)} options={options("district")}/>
    <Select label="Grupa" value={filters.group} onChange={value=>update("group",value)} options={options("groupName")}/>
    <NumberFilter label="Cena minimalna (PLN)" value={filters.minPrice??null} onChange={value=>update("minPrice",value)}/>
    <NumberFilter label="Cena maksymalna (PLN)" value={filters.maxPrice} onChange={value=>update("maxPrice",value)}/>
    <NumberFilter label="Powierzchnia min. (m²)" value={filters.minArea??null} onChange={value=>update("minArea",value)}/>
    <NumberFilter label="Powierzchnia maks. (m²)" value={filters.maxArea??null} onChange={value=>update("maxArea",value)}/>
    <NumberFilter label="Maks. cena za m² (PLN)" value={filters.maxPricePerSqm} onChange={value=>update("maxPricePerSqm",value)}/>
    <p className="text-xs text-muted-foreground">Przy limicie zł/m² oferty bez ceny za m² pozostają widoczne.</p>
    <fieldset className="min-w-0"><legend className="mb-1 text-xs text-muted-foreground">Pokoje</legend><div className="flex flex-wrap gap-2">{[1,2,3,4,5,6].map(room=><label key={room} className="flex min-h-11 items-center gap-1 rounded-lg border px-2 text-sm"><input type="checkbox" checked={filters.roomOptions?.includes(room)??false} onChange={()=>setFilters(current=>({...current,rooms:null,roomOptions:current.roomOptions?.includes(room)?current.roomOptions.filter(value=>value!==room):[...(current.roomOptions??[]),room]}))}/>{room}</label>)}</div></fieldset>
    <NumberFilter label="Piętro minimalne" value={filters.minFloor??null} onChange={value=>update("minFloor",value)}/>
    <NumberFilter label="Piętro maksymalne" value={filters.maxFloor??null} onChange={value=>update("maxFloor",value)}/>
    <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={filters.excludeGroundFloor??false} onChange={event=>update("excludeGroundFloor",event.target.checked)}/>Wyklucz parter</label>
    <label className="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" checked={filters.excludeTopFloor??false} onChange={event=>update("excludeTopFloor",event.target.checked)}/>Wyklucz ostatnie piętro</label>
    <NumberFilter label="Minimalny Flip Score" value={filters.minFlipScore} onChange={value=>update("minFlipScore",value)}/>
    <NumberFilter label="Minimalny zysk (PLN)" value={filters.minProfit??null} onChange={value=>update("minProfit",value)}/>
    <NumberFilter label="Opportunity min." value={filters.minOpportunityScore} onChange={value=>update("minOpportunityScore",value)}/>
    <Select label="Rynek" value={filters.marketType==="all"?"":filters.marketType??""} onChange={value=>update("marketType",value?value as "primary"|"secondary":"all")} options={["primary","secondary"]} labels={{primary:"Pierwotny",secondary:"Wtórny"}}/>
    <Select label="Sprzedający" value={filters.sellerType==="all"?"":filters.sellerType} onChange={value=>update("sellerType",value?value as "private"|"agency":"all")} options={["private","agency"]} labels={{private:"Prywatny",agency:"Pośrednik"}}/>
    <Select label="Stan" value={filters.condition==="all"?"":filters.condition} onChange={value=>update("condition",value?value as "renovation"|"ready":"all")} options={["renovation","ready"]} labels={{renovation:"Do remontu",ready:"Do wejścia"}}/>
    <Select label="Data publikacji" value={filters.publishedDays?.toString()??""} onChange={value=>update("publishedDays",value?Number(value):null)} options={["1","7","30","90"]} labels={{"1":"24 godziny","7":"7 dni","30":"30 dni","90":"90 dni"}}/>
    <button type="button" className="min-h-11 min-w-0 self-end rounded-xl border px-3 text-sm font-semibold" onClick={()=>setFilters({...EMPTY_FACEBOOK_INBOX_FILTERS,roomOptions:[],query:filters.query})}>Wyczyść filtry</button>
  </div>;
}
function Counter({label,value,tone}:{label:string;value:number;tone?:"fire"}){return <div className={`ui-card p-4 ${tone==="fire"?"border-orange-500/25 bg-orange-500/[0.06]":""}`}><p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 font-mono text-2xl font-bold ${tone==="fire"?"text-orange-400":""}`}>{value}</p></div>}
function WorkflowBadge({status}:{status:FacebookWorkflowStatus}){return <Badge text={STATUS_LABELS[status]} tone={status==="interesting"?"gold":status==="rejected"?"fire":undefined}/>}
function Badge({text,tone}:{text:string;tone?:"gold"|"fire"}){return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${tone==="gold"?"border-gold/30 bg-gold/10 text-gold":tone==="fire"?"border-orange-500/30 bg-orange-500/10 text-orange-400":"border-border bg-muted text-muted-foreground"}`}>{text}</span>}
function Action({label,onClick,disabled,icon,buttonRef}:{label:string;onClick:()=>void;disabled:boolean;icon?:React.ReactNode;buttonRef?: (element:HTMLButtonElement|null)=>void}){return <button className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold hover:border-gold/40 hover:text-gold disabled:opacity-50" disabled={disabled} onClick={onClick} ref={buttonRef}>{icon}{label}</button>}
function Select({label,value,onChange,options,labels={}}:{label:string;value:string;onChange:(value:string)=>void;options:string[];labels?:Record<string,string>}){return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{label}<select aria-label={label} className="h-11 min-w-0 w-full max-w-full rounded-xl border bg-background px-2 text-sm text-foreground" value={value} onChange={event=>onChange(event.target.value)}><option value="">Wszystkie</option>{options.map(option=><option key={option} value={option}>{labels[option]??option}</option>)}</select></label>}
function NumberFilter({label,value,onChange}:{label:string;value:number|null;onChange:(value:number|null)=>void}){return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{label}<input className="h-11 min-w-0 w-full max-w-full rounded-xl border bg-background px-3 text-sm text-foreground" min="0" step="any" inputMode="decimal" type="number" value={value??""} onChange={event=>onChange(event.target.value?Number(event.target.value):null)}/></label>}
function dateTime(value:string|null){return value?new Intl.DateTimeFormat("pl-PL",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value)):"brak"}
function sourceName(value:string){return value==="olx"?"OLX":value==="otodom"?"Otodom":value==="morizon"?"Morizon":value}
const LIFECYCLE_STATUS_VALUES=new Set(["ACTIVE","REVIEW","STALE","ARCHIVED","REJECTED"]);
function facebookLifecycleStatus(value:string|null|undefined):"ACTIVE"|"REVIEW"|"STALE"|"ARCHIVED"|"REJECTED"|undefined{return typeof value==="string"&&LIFECYCLE_STATUS_VALUES.has(value)?value as never:undefined;}
function toFilterResult(item:FacebookWatcherListing):FilterResult { const eventAt=item.publishedAt??item.importedAt; const bucket=item.currentFilterDecision??"REJECTED"; const review=item.currentFilterReasons?.includes("review")===true; return {id:item.listingId,title:item.title,price:item.price,area:item.area,rooms:item.rooms,floor:item.floor===null?null:String(item.floor),totalFloors:item.totalFloors===null?null:String(item.totalFloors),buildingType:null,ownership:null,description:item.description,images:item.images,pricePerSqm:item.pricePerSqm,locationText:composeFacebookLocation({street:item.street,neighborhood:item.neighborhood,district:item.district,city:item.city}),address:item.street,city:item.city,district:item.district,thumbnailUrl:item.images[0]??null,sourcePostUrl:item.sourcePostUrl??null,originalUrl:resolveListingUrl({source:"facebook",sourcePostUrl:item.sourcePostUrl,originalUrl:item.originalUrl}),source:"facebook",listingStatus:item.status==="removed"||item.status==="sold"||item.status==="watched"?item.status:"active",lifecycleStatus:facebookLifecycleStatus(item.lifecycleStatus),isActive:item.status==="active",publishedAt:item.publishedAt,firstSeenAt:item.importedAt,lastSeenAt:eventAt,firstMatchedAt:item.importedAt,lastMatchedAt:item.importedAt,previousPrice:null,currentPrice:item.price,isNew:item.isNew,hasPriceDrop:false,priceDropAmount:null,matchReasons:item.currentFilterReasons??item.flags,unknownFields:item.currentFilterMissingFields??[],decisionBucket:bucket,canonicalDecisionDebug:undefined,finderStatus:item.finderStatus??(review?"REVIEW":bucket)}; }
