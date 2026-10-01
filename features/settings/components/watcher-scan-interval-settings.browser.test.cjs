/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const now = "2026-09-10T12:00:00.000Z";
const operatorSession = {
  access_token: "settings-browser-access-token",
  refresh_token: "settings-browser-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
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
      server.close((error) => (error ? reject(error) : resolve(port)));
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

test("Settings can change and re-read the persisted global Watcher interval", { timeout: 300_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  let storedInterval = 30;
  let putBody = null;
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
  const childEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(), NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "browser-test-publishable-key" };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    build.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed (${code}): ${output}`))));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/settings`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const baseUrl = `http://127.0.0.1:${port}`;
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  await page.route("**/api/facebook-watcher/scheduler-settings", async (route) => {
    if (route.request().method() === "PUT") {
      putBody = JSON.parse(route.request().postData() || "{}");
      storedInterval = putBody.intervalMinutes;
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, intervalMinutes: storedInterval }) });
  });

  await page.goto(`${baseUrl}/settings`);
  const input = page.getByLabel("Czas między skanami Watchera");
  await input.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector('input[aria-label="Czas między skanami Watchera"]');
    return element instanceof HTMLInputElement && !element.disabled && element.value === "30";
  });
  assert.equal(await input.inputValue(), "30");
  await input.fill("45");
  await page.getByRole("button", { name: "Zapisz interwał Watchera" }).click();
  await page.getByRole("status").waitFor({ state: "visible" });
  assert.deepEqual(putBody, { intervalMinutes: 45 });
  assert.match(await page.getByRole("status").textContent(), /Interwał zapisany/);
  await page.reload();
  await input.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector('input[aria-label="Czas między skanami Watchera"]');
    return element instanceof HTMLInputElement && !element.disabled && element.value === "45";
  });
  assert.equal(await input.inputValue(), "45", "the value returned by the persisted settings endpoint survives refresh");
  await page.close();
});
