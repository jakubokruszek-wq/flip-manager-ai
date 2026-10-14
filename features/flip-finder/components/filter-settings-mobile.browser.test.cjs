/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

/**
 * Real-browser proof for "Ustawienia filtra" on phones (Samsung report,
 * 14.10.2026): the old dropdown (absolute right-0, w-[min(92vw,34rem)])
 * was aligned to a narrow trigger and ran off the LEFT edge of the screen,
 * and the filter actions hid behind a three-dots menu. The real Next build
 * renders the page; only the Finder API is mocked.
 */

const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-14T12:00:00.000Z";
const operatorSession = {
  access_token: "browser-test-access-token",
  refresh_token: "browser-test-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user: { id: "44444444-4444-4444-8444-444444444444", email: "operator@example.test", app_metadata: { role: "operator" }, user_metadata: {}, aud: "authenticated", created_at: now },
};

// Deliberately long values: wrapping must never widen the dialog.
const filter = {
  id: filterId,
  name: "Flip Łódź Bałuty Teofilów Widzew Śródmieście — mieszkania do remontu bez pośredników",
  sources: ["otodom", "olx", "morizon", "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "szybko", "domy"],
  city: "Łódź",
  districts: ["Bałuty", "Teofilów", "Widzew-Wschód", "Śródmieście-Wschód", "Polesie", "Górna", "Retkinia-Zachód-Smulsko"],
  priceMin: null, priceMax: 450_000, areaMin: 31, areaMax: 75, rooms: [1, 2, 3, 4], floorMin: null, floorMax: null,
  excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false,
  maxPricePerSqm: 6_500, requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60, finderScanIntervalMinutes: 300, isActive: true, lastScannedAt: now, createdAt: now, updatedAt: now,
  totalMatches: 0, newMatches: 0, lastScan: null,
};
const listPayload = { filters: [filter], latestScan: null, summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 0, activeListings: 0, removedListings: 0, newMatches: 0 } };
const resultsPayload = { filter, results: [], reviewResults: [], archivedResults: [], counts: { active: 0, review: 0, archived: 0 }, total: 0, newMatches: 0, lastScan: null, sourceScans: [] };

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

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
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

test("Ustawienia filtra: centred, scrollable dialog with every action visible on phones and desktop", { timeout: 600_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const authServer = http.createServer((request, response) => {
    if (request.url === "/auth/v1/user") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(operatorSession.user)); return; }
    if (request.url?.startsWith("/rest/v1/")) { response.writeHead(200, { "content-type": "application/json" }); response.end("[]"); return; }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => { authServer.once("error", reject); authServer.listen(authPort, "127.0.0.1", resolve); });
  t.after(() => authServer.close());
  const offlinePreload = path.resolve(root, "features/test-support/offline-next.cjs");
  const childEnv = {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
    NODE_ENV: "test",
    NODE_OPTIONS: `--use-system-ca --require=${offlinePreload}`,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "browser-test-publishable-key",
  };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build", "--webpack"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let buildOutput = "";
    build.stdout.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed with exit code ${code}; output: ${buildOutput}`))));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/flip-finder`);
  // CI installs Playwright's own Chromium; a sandbox may provide another build at a fixed path.
  const executablePath = process.env.FINDER_TEST_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const actions = [];
  async function openPage({ width, height, colorScheme = "dark" }) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: width < 600, hasTouch: width < 600, colorScheme });
    await context.addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.route("**/api/flip-finder/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/flip-finder/search-filters") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listPayload) });
      if (url.pathname.endsWith("/results")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resultsPayload) });
      if (url.pathname.endsWith("/latest-run")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: null }) });
      if (url.pathname === `/api/flip-finder/search-filters/${filterId}` && request.method() === "DELETE") { actions.push("delete"); return route.fulfill({ status: 204, body: "" }); }
      for (const action of ["toggle", "duplicate"]) {
        if (url.pathname === `/api/flip-finder/search-filters/${filterId}/${action}` && request.method() === "POST") { actions.push(action); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    t.after(() => context.close().catch(() => undefined));
    await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("heading", { name: filter.name }).first().waitFor({ state: "visible", timeout: 60_000 });
    } catch (error) {
      throw new Error(`${error.message}\nURL: ${page.url()}\nPAGE: ${(await page.locator("body").innerText()).slice(0, 600)}`);
    }
    return page;
  }
  const dialogOf = (page) => page.getByTestId("filter-settings-dialog");
  async function openSettings(page) {
    await page.getByRole("button", { name: "Ustawienia filtra" }).click();
    const dialog = dialogOf(page);
    await dialog.waitFor({ state: "visible" });
    await page.waitForTimeout(300); // open animation (zoom-in-95) must not skew the geometry
    return dialog;
  }
  async function assertInsideViewport(page, locator, what) {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box, `${what}: rendered`);
    assert.ok(box.x >= 0, `${what}: not past the left edge (x=${box.x})`);
    assert.ok(box.x + box.width <= viewport.width + 0.5, `${what}: not past the right edge (${box.x + box.width} > ${viewport.width})`);
  }
  async function noHorizontalScroll(page) {
    return page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="filter-settings-dialog"]');
      return {
        document: document.documentElement.scrollWidth <= window.innerWidth,
        dialog: dialog ? dialog.scrollWidth <= dialog.clientWidth : true,
      };
    });
  }
  const ACTIONS = ["Edytuj filtr", "Wstrzymaj", "Duplikuj", "Usuń"];
  const LABELS = ["Lokalizacja", "Maks. cena za m²", "Powierzchnia", "Liczba pokoi", "Aktywne źródła ogłoszeń"];

  for (const [width, height] of [[320, 568], [360, 740], [390, 844], [430, 932], [1280, 800]]) {
    await t.test(`${width}px: dialog centred within the screen, all information and four direct actions, no horizontal scroll`, async () => {
      const page = await openPage({ width, height });
      assert.equal(await page.getByText("Więcej akcji filtra").count(), 0, "no three-dots menu any more");
      const dialog = await openSettings(page);
      await assertInsideViewport(page, dialog, "dialog");
      const box = await dialog.boundingBox();
      assert.ok(box.height <= height - 32 + 1, `dialog fits the screen height minus 2rem (${box.height} / ${height})`);
      assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1, "horizontally centred");
      if (width >= 640) assert.ok(box.width <= 576 + 0.5, "max-w-xl on desktop");
      else assert.ok(Math.abs(box.width - (width - 32)) <= 1, "phone: full width minus the 1rem gutters");
      assert.deepEqual(await noHorizontalScroll(page), { document: true, dialog: true });
      for (const label of LABELS) await dialog.locator("dt", { hasText: label }).first().waitFor({ state: "attached" });
      const text = await dialog.innerText();
      assert.match(text, /Łódź · Bałuty, Teofilów/);
      assert.match(text, /6\s?500\s?zł/);
      assert.match(text, /31–75 m²/);
      assert.match(text, /1, 2, 3, 4/);
      assert.match(text, /Otodom/);
      assert.match(text, /Morizon/);
      for (const name of ACTIONS) {
        const action = dialog.getByRole(name === "Edytuj filtr" ? "button" : "button", { name, exact: true });
        await action.scrollIntoViewIfNeeded();
        assert.ok(await action.isVisible(), `${name}: directly visible`);
        assert.ok(await action.isEnabled(), `${name}: enabled`);
        await assertInsideViewport(page, action, name);
        const actionBox = await action.boundingBox();
        assert.ok(actionBox.height >= 44 - 0.5, `${name}: touch target at least 44px (${actionBox.height})`);
      }
      assert.equal(await dialog.locator(`a[href="/flip-finder/filters/${filterId}/edit?returnTo=%2Fflip-finder&activeFilter=${filterId}"]`).count(), 1, "Edytuj filtr keeps its link");
      // Close with the X button, Escape and a click on the backdrop.
      await dialog.getByRole("button", { name: "Zamknij" }).click();
      await dialog.waitFor({ state: "hidden" });
      await openSettings(page);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await openSettings(page);
      await page.mouse.click(4, 4);
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await noHorizontalScroll(page), { document: true, dialog: true });
    });
  }

  await t.test("320px: long content scrolls vertically inside the dialog, header with Zamknij stays reachable", async () => {
    const page = await openPage({ width: 320, height: 480 });
    const dialog = await openSettings(page);
    const metrics = await dialog.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowY: getComputedStyle(element).overflowY }));
    assert.equal(metrics.overflowY, "auto");
    assert.ok(metrics.scrollHeight > metrics.clientHeight, "content taller than the screen scrolls");
    await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const remove = dialog.getByRole("button", { name: "Usuń", exact: true });
    assert.ok(await remove.isVisible());
    await assertInsideViewport(page, remove, "Usuń after scrolling");
    const close = dialog.getByRole("button", { name: "Zamknij" });
    const closeBox = await close.boundingBox();
    assert.ok(closeBox.y >= 0 && closeBox.y < 480, "sticky header keeps Zamknij on screen after scrolling");
    await close.click();
    await dialog.waitFor({ state: "hidden" });
  });

  await t.test("360px: actions keep their behaviour; deleting still needs confirmation", async () => {
    const page = await openPage({ width: 360, height: 740 });
    let dialog = await openSettings(page);
    await dialog.getByRole("button", { name: "Wstrzymaj", exact: true }).click();
    await page.getByText("Filtr został wstrzymany.").waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Duplikuj", exact: true }).click();
    await page.getByText("Utworzono kopię filtra.").waitFor({ state: "visible" });
    assert.deepEqual(actions.splice(0), ["toggle", "duplicate"]);
    await dialog.getByRole("button", { name: "Usuń", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Usunąć filtr?" });
    await confirmation.waitFor({ state: "visible" });
    await assertInsideViewport(page, confirmation, "confirmation");
    assert.deepEqual(actions, [], "nothing deleted before confirming");
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    assert.ok(await dialog.isVisible(), "cancelling the confirmation returns to the settings");
    assert.deepEqual(actions, []);
    await dialog.getByRole("button", { name: "Usuń", exact: true }).click();
    await confirmation.getByRole("button", { name: "Usuń filtr" }).click();
    await page.getByText("Filtr został usunięty.").waitFor({ state: "visible" });
    assert.deepEqual(actions.splice(0), ["delete"]);
    dialog = dialogOf(page);
    await dialog.waitFor({ state: "hidden" });
  });

  for (const colorScheme of ["light", "dark"]) {
    await t.test(`${colorScheme} colour scheme: opaque dialog with readable text and gold accents`, async () => {
      const page = await openPage({ width: 390, height: 844, colorScheme });
      const dialog = await openSettings(page);
      const colors = await dialog.evaluate((element) => {
        const title = element.querySelector("h2");
        const accent = element.querySelector("p");
        return { background: getComputedStyle(element).backgroundColor, title: getComputedStyle(title).color, accent: getComputedStyle(accent).color };
      });
      assert.notEqual(colors.background, "rgba(0, 0, 0, 0)", "the dialog has its own background");
      assert.notEqual(colors.title, colors.background, "title readable against the background");
      assert.match(colors.accent, /^(?:rgb\(214, 179, 90\)|oklch|color\()/, `gold eyebrow (${colors.accent})`);
    });
  }
});
