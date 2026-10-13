/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

// Regression for Production 2026-10-13 (run 97183d20): the phone showed
// "Oczekiwanie na kontynuację" with a raw "Failed to fetch", and one failed
// request had silently ended every later refresh of the Radar page.
const districts = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"];
const ownerId = "44444444-4444-4444-8444-444444444444";
const runId = "97183d20-ae89-4e59-b970-8271be828921";
const session = {
  access_token: "radar-browser-access-token", refresh_token: "radar-browser-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
  user: { id: ownerId, email: "operator@example.test", app_metadata: { role: "operator" }, user_metadata: {}, aud: "authenticated", created_at: "2026-10-01T00:00:00.000Z" },
};
function defaultFilters() { return { districts, market: "both", areaMin: null, areaMax: null, rooms: [], sources: [], minPricePerSqm: null, automaticScanEnabled: true, automaticScanTime: "08:00" }; }
function runningRun(scannedCount, qualifiedCount, leaseOffsetMs) {
  return {
    id: runId, status: "running", startedAt: "2026-10-13T06:08:00.000Z", finishedAt: null,
    leaseUntil: new Date(Date.now() + leaseOffsetMs).toISOString(), stopRequestedAt: null, userTerminatedAt: null,
    scannedCount, qualifiedCount,
    sourceStatuses: { adresowo: "failed", domiporta: "running", oferty_net: "pending", olx: "pending" },
    sourceErrors: { adresowo: "TERMINAL_ACCESS_ERROR: HTTP 403 CAPTCHA_OR_ACCESS_DENIED" },
    checkpoint: { sourceQueue: ["adresowo", "domiporta", "oferty_net", "olx"], currentSourceIndex: 1, lastProgressAt: "2026-10-13T06:18:04.000Z" },
    errorMessage: null,
  };
}
async function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); });
}
async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => { const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode < 500); }); request.setTimeout(1000, () => request.destroy()); request.once("error", () => resolve(false)); });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Radar browser test server did not become ready");
}

test("the Radar PWA keeps refreshing across app switches, lost network, server errors, HTTP 409 and finished runs", { timeout: 600_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const authServer = http.createServer((request, response) => {
    if (request.url === "/auth/v1/user") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(session.user)); return; }
    if (request.url?.startsWith("/rest/v1/")) { response.writeHead(200, { "content-type": "application/json" }); response.end("[]"); return; }
    response.writeHead(404); response.end("{}");
  });
  await new Promise((resolve, reject) => { authServer.once("error", reject); authServer.listen(authPort, "127.0.0.1", resolve); });
  t.after(() => authServer.close());
  // Same isolation as the other Radar browser tests: no inherited secrets, no .env.local.
  const offlinePreload = path.resolve(root, "features/test-support/offline-next.cjs");
  const childEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: "test", NODE_OPTIONS: `--use-system-ca --require=${offlinePreload}`, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "radar-browser-test-publishable-key" };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build", "--webpack"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    build.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
    build.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
    build.once("error", reject);
    build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`isolated Next build failed (${code}): ${output}`)));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-8000); });
  server.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-8000); });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/price-radar`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await context.addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(session), url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: "Lax" }]);

  let radarRun = null;
  let networkDown = false;
  let nextRunGetStatus = null;
  let onResumePost = null;
  const runGets = [];
  const runPosts = [];
  await page.route("**/api/price-radar/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (networkDown) return route.abort("internetdisconnected");
    if (url.pathname === "/api/price-radar/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: defaultFilters(), activeSources: ["domiporta", "olx", "oferty_net", "adresowo"], disabledSourceNote: "" }) });
    if (url.pathname === "/api/price-radar/results") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listings: [], excludedListings: [], stats: [] }) });
    if (url.pathname === "/api/price-radar/district-queue" || url.pathname === "/api/price-radar/verification-queue") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, pending: [], assigned: [], confirmed: [], rejected: [] }) });
    if (url.pathname === "/api/price-radar/run" && request.method() === "GET") {
      runGets.push(Date.now());
      if (nextRunGetStatus) {
        const status = nextRunGetStatus;
        nextRunGetStatus = null;
        return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message: "upstream failure" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: radarRun }) });
    }
    if (url.pathname === "/api/price-radar/run" && request.method() === "POST") {
      runPosts.push(request.postDataJSON());
      const handled = onResumePost ? onResumePost() : null;
      if (handled) return route.fulfill(handled);
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "unexpected POST" }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "unexpected Radar request" }) });
  });
  const returnToApp = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const collectionText = () => page.getByRole("region", { name: "Zbieranie ofert Radaru" }).innerText();

  await page.goto(`http://127.0.0.1:${port}/price-radar`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: districts[0] }).waitFor();
  await page.getByText("Brak uruchomionego przebiegu.").waitFor();

  // 1. A run started on another device appears as soon as the PWA is shown again.
  radarRun = runningRun(433, 24, 60_000);
  radarRun.checkpoint.progress = {
    lastRealProgressAt: "2026-10-13T08:35:00.000Z", lastProgressSource: "oferty_net", noProgressPortions: 4,
    sourceNoProgressAttempts: { domiporta: 2 }, waitingReason: "next_portion",
    lastContinuationError: { at: "2026-10-13T08:42:41.000Z", hop: 17, reason: "ACK_TIMEOUT" },
  };
  await returnToApp();
  await page.getByText(/433 sprawdzonych · 24 zakwalifikowanych/u).waitFor({ timeout: 10_000 });
  const diagnostics = await page.getByRole("region", { name: "Automatyczne skanowanie" }).innerText();
  assert.match(diagnostics, /Aktualne źródło\s+Domiporta/u);
  assert.match(diagnostics, /Ostatni rzeczywisty postęp\s+.*Oferty\.net/u, "real progress is shown separately from checkpoint writes");
  assert.match(diagnostics, /Ostatni zapis checkpointu/u);
  assert.match(diagnostics, /Powód oczekiwania\s+Następna porcja na serwerze · porcje bez postępu: 4/u);
  assert.match(diagnostics, /Ostatni błąd przekazania\s+.*krok 17 · ACK_TIMEOUT/u);
  assert.match(await collectionText(), /Domiporta: pobieranie · próby bez postępu: 2/u);

  // 2. Lost network: an understandable message plus the last known progress, never "Failed to fetch".
  networkDown = true;
  await context.setOffline(true);
  await returnToApp();
  await page.getByText(/Brak połączenia z internetem/u).first().waitFor({ timeout: 10_000 });
  const offlineText = await collectionText();
  assert.match(offlineText, /Ostatni znany stan: 433 sprawdzonych, 24 zakwalifikowanych/u);
  assert.equal(await page.getByText(/Failed to fetch/iu).count(), 0, "the raw browser error is never shown");
  radarRun = runningRun(440, 27, 60_000);
  networkDown = false;
  await context.setOffline(false);
  await page.getByText(/440 sprawdzonych · 27 zakwalifikowanych/u).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText(/Brak połączenia z internetem/u).count(), 0, "the notice clears once the server answers again");

  // 3. A server error is reported as such (not as a lost connection) and polling keeps going.
  nextRunGetStatus = 503;
  await returnToApp();
  await page.getByText(/Serwer Radaru chwilowo nie odpowiada/u).waitFor({ timeout: 10_000 });
  const getsAfterError = runGets.length;
  await page.waitForFunction(() => !document.body.textContent?.includes("Serwer Radaru chwilowo nie odpowiada"), null, { timeout: 30_000 });
  assert.ok(runGets.length > getsAfterError, "a failed refresh schedules the next one by itself");

  // 4. Expired lease -> one resume attempt -> HTTP 409 -> the latest server state is fetched and shown.
  radarRun = runningRun(440, 27, -5 * 60_000);
  onResumePost = () => {
    radarRun = runningRun(452, 28, 60_000);
    return { status: 409, contentType: "application/json", body: JSON.stringify({ code: "run_changed", message: "The Radar run was not resumed; refresh its current state." }) };
  };
  await returnToApp();
  await page.getByText(/452 sprawdzonych · 28 zakwalifikowanych/u).waitFor({ timeout: 15_000 });
  await page.getByText(/Przebieg kontynuuje inny proces/u).waitFor();
  assert.deepEqual(runPosts, [{ expectedRunId: runId }], "the PWA only asks to continue the same run ID, once");
  assert.equal(await page.getByText(/no longer resumable|not resumed/u).count(), 0, "409 is not shown as an error");

  // 5. After the run finishes the page keeps polling and picks up a later run without any user action.
  radarRun = { ...runningRun(510, 31, 0), status: "partial", finishedAt: new Date().toISOString(), leaseUntil: null, sourceStatuses: { adresowo: "failed", domiporta: "completed", oferty_net: "failed", olx: "completed" } };
  await returnToApp();
  await page.getByText(/Częściowe pokrycie · 510 sprawdzonych/u).waitFor({ timeout: 15_000 });
  radarRun = { ...runningRun(3, 0, 60_000), id: "11111111-1111-4111-8111-111111111111", startedAt: new Date().toISOString() };
  await page.getByText(/3 sprawdzonych · 0 zakwalifikowanych/u).waitFor({ timeout: 70_000 });
  assert.equal(runPosts.length, 1, "observing a run never starts or resumes one by itself while its lease is active");
  assert.equal(serverOutput.includes("Error:"), false, serverOutput);
});
