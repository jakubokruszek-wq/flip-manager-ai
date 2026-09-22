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
    originalUrl: "https://www.facebook.com/groups/example/permalink/1749121366325600/",
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

const listingsPayload = {
  listings: [
    makeListing({ listingId: "00000000-0000-4000-8000-000000000001", title: "Mieszkanie 3 pokoje, Widzew" }),
    makeListing({ listingId: "00000000-0000-4000-8000-000000000002", title: "Kawalerka, Bałuty", price: 280_000, area: 32, rooms: 1, pricePerM2: 8750, pricePerSqm: 8750 }),
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
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
];

const ARTIFACT_DIR = path.join(os.tmpdir(), "claude-watcher-browser-verification");

test("real Facebook Watcher card UI: one gold wrapper per listing, no action-row horizontal scroll, at every required viewport", { timeout: 240_000 }, async (t) => {
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
  // (KPI section, diagnostics, filter controls, two full listing cards) than
  // the simpler fixtures other .browser.test.cjs files boot against, and the
  // first request also pays for the route's cold webpack compile.
  await waitForServer(`http://127.0.0.1:${port}/facebook-watcher`, 90_000);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await browser.newPage();
  await page.route("**/api/facebook-watcher/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/facebook-watcher/listings") return route.fulfill({ contentType: "application/json", body: JSON.stringify(listingsPayload), status: 200 });
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

  const results = {};

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Let layout settle after the resize before measuring.
    await page.waitForTimeout(150);

    const articles = page.locator('article[id^="facebook-inbox-"]');
    const wrapperCount = await articles.count();

    const first = articles.first();
    const outerStyle = await first.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { borderWidth: computed.borderWidth, borderColor: computed.borderColor, borderStyle: computed.borderStyle };
    });
    await first.hover();
    await page.waitForTimeout(350); // exceed the 300ms transition-colors duration
    const hoverStyle = await first.evaluate((element) => getComputedStyle(element).borderColor);
    await page.mouse.move(0, 0);

    const innerPanelStyle = await first.locator("> div").first().evaluate((element) => getComputedStyle(element).borderWidth);

    const actionRow = first.locator("div.mt-3.flex-wrap.gap-2");
    const actionRowMetrics = await actionRow.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));

    const documentOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    results[viewport.name] = { wrapperCount, outerStyle, hoverBorderColor: hoverStyle, innerPanelBorderWidth: innerPanelStyle, actionRowMetrics, documentOverflow };

    await page.screenshot({ path: path.join(ARTIFACT_DIR, `watcher-${viewport.name}.png`), fullPage: true });

    assert.equal(wrapperCount, 2, `${viewport.name}: exactly one <article> wrapper per fixture listing`);
    assert.equal(outerStyle.borderWidth, "1px", `${viewport.name}: outer wrapper border must be 1px; server output: ${output}`);
    assert.equal(innerPanelStyle, "0px", `${viewport.name}: inner status/action panel must carry no border of its own (no second outline)`);
    assert.ok(actionRowMetrics.scrollWidth <= actionRowMetrics.clientWidth + 1, `${viewport.name}: action row scrollWidth (${actionRowMetrics.scrollWidth}) must not exceed clientWidth (${actionRowMetrics.clientWidth})`);
    assert.notEqual(actionRowMetrics.overflowX, "auto", `${viewport.name}: action row overflow-x must not be auto`);
    assert.notEqual(actionRowMetrics.overflowX, "scroll", `${viewport.name}: action row overflow-x must not be scroll`);
    assert.ok(documentOverflow.scrollWidth <= documentOverflow.clientWidth + 1, `${viewport.name}: no document-level horizontal overflow (scrollWidth ${documentOverflow.scrollWidth} vs clientWidth ${documentOverflow.clientWidth})`);
    assert.notEqual(hoverStyle, outerStyle.borderColor, `${viewport.name}: hovering the listing must visibly change the border color (20% -> 45% opacity)`);
  }

  console.log(`WATCHER_BROWSER_VERIFICATION_RESULTS=${JSON.stringify(results, null, 2)}`);
  console.log(`Screenshots saved to: ${ARTIFACT_DIR}`);
  await page.close();
});
