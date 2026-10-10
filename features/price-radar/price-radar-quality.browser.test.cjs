/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, startFakeSupabaseAuthServer } = require("../test-support/browser-auth.cjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode < 500); });
      request.setTimeout(1500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Radar browser test server did not become ready");
}

test("Radar separates A/B samples, persists the optional price filter, and keeps exclusion through reload", { timeout: 300_000 }, async (t) => {
  const port = await freePort();
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());
  const root = path.resolve(__dirname, "../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: "test",
    NODE_OPTIONS: "--use-system-ca",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "price-radar-browser-test-key",
  };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    build.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`next build failed (${code}): ${output}`)));
  });

  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/price-radar`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await addOperatorSessionCookie(page.context(), baseUrl);

  let savedFilters = { districts: ["Bałuty"], market: "both", areaMin: 31, areaMax: 62, rooms: [1, 2, 3], sources: ["oferty_net"], minPricePerSqm: null };
  let excluded = false;
  let runPostCount = 0;
  const listing = (id, pricePerSqm, qualityCategory, renovationStatus) => ({
    id, source: "oferty_net", externalListingId: id, originalUrl: `https://www.oferty.net/${id}`, normalizedUrl: `https://www.oferty.net/${id}`,
    title: id === "fresh-a" ? "Łanowa · świeży remont" : "Elsnera · wysoki standard", description: null,
    price: pricePerSqm * 45, area: 45, pricePerSqm, rooms: 2, city: "Łódź", district: "Bałuty", buildingType: "blok", marketType: "secondary",
    renovationStatus, qualityCategory, contentHash: id, firstSeenAt: "2026-10-10T12:00:00Z", lastSeenAt: "2026-10-10T12:00:00Z",
    publishedAt: null, sourceUpdatedAt: null, collectedAt: "2026-10-10T12:00:00Z", crossSourceIdentity: null, crossSourceAlternates: [],
    status: "active", excludedAt: excluded && id === "fresh-a" ? "2026-10-10T12:30:00Z" : null, excludedReason: excluded && id === "fresh-a" ? "browser regression" : null,
  });
  const all = [listing("fresh-a", 9_600, "fresh_renovation", "fresh_renovation"), listing("ready-b", 9_200, "ready_high_standard", "turnkey_finish")];
  const statsFor = (visible) => {
    const groups = new Map();
    for (const item of visible) {
      const key = `${item.district}|${item.marketType}|${item.qualityCategory}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()].map((group) => ({
      district: group[0].district, marketType: group[0].marketType, qualityCategory: group[0].qualityCategory,
      sampleSize: group.length, isSmallSample: group.length < 20, averagePricePerSqm: null, medianPricePerSqm: null, updatedAt: group[0].lastSeenAt,
    }));
  };

  await page.route("**/api/price-radar/settings", async (route) => {
    if (route.request().method() === "PUT") savedFilters = JSON.parse(route.request().postData() || "{}").filters;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: savedFilters, activeSources: ["oferty_net"], disabledSourceNote: "" }) });
  });
  await page.route("**/api/price-radar/run", async (route) => {
    if (route.request().method() === "POST") runPostCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: null }) });
  });
  await page.route("**/api/price-radar/results?*", async (route) => {
    const requestedMinimum = Number(new URL(route.request().url()).searchParams.get("minPricePerSqm") || 0);
    const eligible = all.filter((item) => item.pricePerSqm >= requestedMinimum);
    const visible = eligible.filter((item) => !(excluded && item.id === "fresh-a"));
    const excludedListings = eligible.filter((item) => excluded && item.id === "fresh-a");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listings: visible, excludedListings, stats: statsFor(visible), activeSources: ["oferty_net"], disabledSourceNote: "" }) });
  });
  await page.route("**/api/price-radar/exclude", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    excluded = Boolean(body.excluded);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/price-radar`);
  await page.locator("article").filter({ hasText: "A · Po świeżym remoncie" }).waitFor();
  await page.locator("article").filter({ hasText: "B · Gotowe — wysoki standard" }).waitFor();
  assert.equal(await page.locator("article").count(), 2, "both quality categories retain visible cards below the 20-item threshold");
  assert.equal(runPostCount, 0, "viewing the Radar does not start or resume a run");

  const minimum = page.getByLabel("Min. cena ofertowa za m²");
  const settingsSave = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await minimum.fill("9500");
  await settingsSave;
  await page.locator("article").filter({ hasText: "A · Po świeżym remoncie" }).waitFor();
  await page.getByText("Oferty w próbie (1)").waitFor();
  await page.reload();
  await page.getByLabel("Min. cena ofertowa za m²").waitFor();
  assert.equal(await minimum.inputValue(), "9500", "the saved threshold survives refresh");
  await page.getByRole("button", { name: "Wyklucz z porównań" }).click();
  await page.getByText("Oferty w próbie (0)").waitFor();
  await page.getByText("Wykluczone z porównań (1)").waitFor();
  await page.reload();
  await page.getByText("Wykluczone z porównań (1)").waitFor();
  await page.getByRole("button", { name: "Przywróć do porównań" }).click();
  await page.getByText("Oferty w próbie (1)").waitFor();
  await page.reload();
  await page.getByText("Oferty w próbie (1)").waitFor();

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `Radar should not overflow at ${width}px (overflow ${overflow}px)`);
  }
});
