/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { waitForServer } = require("../../features/facebook-watcher/components/browser-readiness.cjs");
const { addOperatorSessionCookie, ensureProductionBuild, operatorSession, startFakeSupabaseAuthServer } = require("../../features/test-support/browser-auth.cjs");

// Real bug this guards against: `refreshOperatorSession` (lib/supabase/auth-proxy.ts)
// was suspected of non-deterministic behavior -- the same unauthenticated
// request sometimes redirected to /login and sometimes served real,
// operator-only content. That was traced (see the commit message and
// features/test-support/browser-auth.cjs) to a TEST-HARNESS artifact: Next
// inlines NEXT_PUBLIC_SUPABASE_URL/KEY at `next build` time, and a stale
// `.next` build baked for a *different* fake auth server could get reused by
// SKIP_BROWSER_BUILD=1, so a forged "operator" cookie sometimes validated
// against the wrong host. The proxy's own decision logic was proven
// deterministic once build and runtime env agree; this test proves it stays
// that way with a real next build + next start (never next dev) and enough
// repeated requests to catch any regression.
const REQUEST_COUNT = 25;

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

test("auth-proxy determinism: protected page/API always reject anonymous requests, operator always passes, against a real next build + next start", { timeout: 300_000 }, async (t) => {
  const port = await freePort();
  const { server: authServer, port: authPort } = await startFakeSupabaseAuthServer();
  t.after(() => authServer.close());

  const root = path.resolve(__dirname, "../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "auth-proxy-determinism-publishable-key",
  };
  await ensureProductionBuild(nextBin, root, env);

  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
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
  });
  await waitForServer(`http://127.0.0.1:${port}/api/build-info`, 90_000);
  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test(`an unauthenticated navigation to a protected page ALWAYS redirects to /login (${REQUEST_COUNT}x, concurrent)`, async () => {
    const results = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () => fetch(`${baseUrl}/flip-finder`, { redirect: "manual" })),
    );
    for (const response of results) {
      assert.equal(response.status, 307, `expected 307, got ${response.status}; server output: ${output}`);
      const location = response.headers.get("location") ?? "";
      assert.ok(new URL(location, baseUrl).pathname === "/login", `expected redirect to /login, got ${location}`);
    }
  });

  await t.test(`an unauthenticated request to a protected API ALWAYS returns 401 JSON (${REQUEST_COUNT}x, concurrent)`, async () => {
    const results = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () => fetch(`${baseUrl}/api/flip-finder/search-filters`, { redirect: "manual" })),
    );
    for (const response of results) {
      assert.equal(response.status, 401, `expected 401, got ${response.status}; server output: ${output}`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "OPERATOR_SESSION_REQUIRED");
    }
  });

  const operatorCookieHeader = `sb-127-auth-token=${JSON.stringify(operatorSession)}`;

  await t.test(`a logged-in operator ALWAYS passes through to the protected page (${REQUEST_COUNT}x, concurrent)`, async () => {
    const results = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        fetch(`${baseUrl}/flip-finder`, { redirect: "manual", headers: { cookie: operatorCookieHeader } })),
    );
    for (const response of results) {
      assert.equal(response.status, 200, `expected 200 for an operator, got ${response.status}; server output: ${output}`);
    }
  });

  await t.test(`a logged-in operator ALWAYS passes through to the protected API (${REQUEST_COUNT}x, concurrent)`, async () => {
    const results = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () =>
        fetch(`${baseUrl}/api/flip-finder/search-filters`, { redirect: "manual", headers: { cookie: operatorCookieHeader } })),
    );
    for (const response of results) {
      assert.equal(response.status, 200, `expected 200 for an operator, got ${response.status}; server output: ${output}`);
    }
  });

  await t.test("a real browser navigation as an operator renders the protected page with zero React/Next console errors", async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await addOperatorSessionCookie(context, baseUrl);
    const page = await context.newPage();
    const unexpectedConsoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") unexpectedConsoleErrors.push(message.text()); });
    page.on("pageerror", (error) => unexpectedConsoleErrors.push(error.message));
    await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Flip Finder", level: 1 }).waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(page.url(), `${baseUrl}/flip-finder`, "operator navigation must not be redirected to /login");
    assert.deepEqual(unexpectedConsoleErrors, [], `no React/Next console errors expected: ${unexpectedConsoleErrors.join(" | ")}`);
  });

  assert.equal(server.exitCode, null, `Next server must still be running at the end of the test; output: ${output}`);
});
