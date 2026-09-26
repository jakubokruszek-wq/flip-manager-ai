/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { ensureProductionBuild } = require("../test-support/browser-auth.cjs");

const user = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "operator@example.test",
  app_metadata: { role: "operator" },
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-09-06T12:00:00.000Z",
};
const session = {
  access_token: "login-browser-access-token",
  refresh_token: "login-browser-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user,
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
      const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode < 500); });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready");
}

test("login, protected navigation and logout use the operator session", { timeout: 180_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const authRequests = [];
  const authServer = http.createServer((request, response) => {
    authRequests.push(`${request.method} ${request.url}`);
    if (request.url === "/auth/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(user));
      return;
    }
    if (request.url?.startsWith("/auth/v1/token")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const credentials = JSON.parse(body || "{}");
        if (credentials.password !== "correct-password") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(session));
      });
      return;
    }
    if (request.url === "/auth/v1/logout") {
      response.writeHead(204);
      response.end();
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

  const root = path.resolve(__dirname, "../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "login-browser-publishable-key",
  };
  await ensureProductionBuild(nextBin, root, env);
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/login`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  let page = await browser.newPage();
  const baseUrl = `http://127.0.0.1:${port}`;
  await page.goto(`${baseUrl}/login?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await assert.doesNotReject(() => page.getByLabel("E-mail").waitFor({ state: "visible" }));
  assert.equal(await page.getByText("Rejestracja").count(), 0, "login must not expose public signup");

  await page.getByLabel("E-mail").fill("operator@example.test");
  await page.getByLabel(/Has/).fill("wrong-password");
  await page.getByRole("button", { name: /Zaloguj/ }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('[role="alert"]')?.textContent?.trim()), null, { timeout: 20_000 });
  assert.notEqual((await page.locator('p[role="alert"]').innerText()).trim(), "");

  await page.close();
  page = await browser.newPage();
  await page.goto(`${baseUrl}/login?returnTo=%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("E-mail").fill("operator@example.test");
  await page.getByLabel(/Has/).fill("correct-password");
  await page.getByRole("button", { name: /Zaloguj/ }).click();
  try {
    await page.waitForURL(`${baseUrl}/dashboard`, { timeout: 20_000 });
  } catch (error) {
    console.error("LOGIN_BROWSER_DIAGNOSTIC", { url: page.url(), cookies: await page.context().cookies(), body: (await page.locator("body").innerText()).slice(0, 500), authRequests, output });
    throw error;
  }
  await page.getByRole("button", { name: /Wyloguj/ }).click();
  await page.waitForURL(/\/login(?:\?|$)/, { timeout: 20_000 });
  assert.equal(server.exitCode, null, `server output: ${output}`);
});
