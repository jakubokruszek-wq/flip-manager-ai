/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const now = "2026-10-13T09:00:00.000Z";
const operatorSession = {
  access_token: "settings-update-browser-access-token",
  refresh_token: "settings-update-browser-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 4_102_444_800,
  user: { id: "44444444-4444-4444-8444-444444444444", email: "operator@example.test", app_metadata: { role: "operator" }, user_metadata: {}, aud: "authenticated", created_at: now },
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

async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
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

test("mobile and desktop can check and safely apply a PWA update without clearing user data", { timeout: 360_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const authServer = http.createServer((request, response) => {
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
  await new Promise((resolve, reject) => { authServer.once("error", reject); authServer.listen(authPort, "127.0.0.1", resolve); });
  t.after(() => authServer.close());

  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "settings-update-browser-publishable-key",
    VERCEL_GIT_COMMIT_SHA: "1111111111111111111111111111111111111111",
  };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    build.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`next build failed (${code}): ${output}`)));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!server.killed) server.kill(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/settings`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await context.addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  let buildInfoRequests = 0;
  await page.route("**/api/build-info", async (route) => {
    buildInfoRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ commitSha: "2222222222222222222222222222222222222222", environment: "production" }) });
  });
  await page.route("**/api/facebook-watcher/scheduler-settings", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, intervalMinutes: 30 }) }));

  await page.goto(`${baseUrl}/settings`);
  await page.getByTestId("version-updates-settings").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("running-app-version").textContent(), "1111111");
  assert.equal(await page.getByTestId("production-app-version").textContent(), "Nie sprawdzono");
  await page.evaluate(async () => {
    localStorage.setItem("settings-update-preservation", "keep-me");
    const cache = await caches.open("settings-update-preservation");
    const request = new Request(new URL("/preserved", window.location.href));
    await cache.put(request, new Response("keep-me"));
  });
  await page.getByRole("button", { name: "Sprawdź aktualizacje" }).click();
  await page.getByText("Dostępna aktualizacja: 2222222").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("production-app-version").textContent(), "2222222");
  assert.equal(buildInfoRequests, 1, "checking performs one uncached build-info request");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "settings fit a 390px mobile viewport");
  assert.ok(await page.getByRole("button", { name: "Aktualizuj" }).evaluate((element) => element.getBoundingClientRect().height >= 44));

  await page.getByRole("button", { name: "Aktualizuj" }).click();
  await page.waitForURL((url) => url.searchParams.has("_app_update"), { timeout: 20_000 });
  await page.getByTestId("version-updates-settings").waitFor({ state: "visible" });
  const preserved = await page.evaluate(async () => ({
    localStorage: localStorage.getItem("settings-update-preservation"),
    cacheNames: await caches.keys(),
    cacheResponse: await (await caches.open("settings-update-preservation")).match(new URL("/preserved", window.location.href)).then((response) => response?.text()),
  }));
  assert.equal(preserved.localStorage, "keep-me");
  assert.ok(preserved.cacheNames.includes("settings-update-preservation"));
  assert.equal(preserved.cacheResponse, "keep-me");

  await page.getByRole("button", { name: "Sprawdź aktualizacje" }).click();
  await page.getByText("Dostępna aktualizacja: 2222222").waitFor({ state: "visible" });
  await page.getByTestId("watcher-scan-interval-settings").locator("input").fill("45");
  let warning = "";
  const urlBeforeDeclinedUpdate = page.url();
  page.once("dialog", async (dialog) => { warning = dialog.message(); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Aktualizuj" }).click();
  assert.match(warning, /zmiany wprowadzone na tej stronie/);
  assert.equal(page.url(), urlBeforeDeclinedUpdate, "declining the warning leaves the current page and form open");

  assert.equal(buildInfoRequests, 2);

  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktopContext.addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const desktop = await desktopContext.newPage();
  await desktop.goto(`${baseUrl}/settings`);
  await desktop.getByTestId("version-updates-settings").waitFor({ state: "visible" });
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "settings fit a desktop viewport");
  await desktopContext.close();
  await context.close();
});
