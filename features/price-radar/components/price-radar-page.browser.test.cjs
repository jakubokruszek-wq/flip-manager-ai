/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

const districts = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"];
const ownerId = "44444444-4444-4444-8444-444444444444";
const session = {
  access_token: "radar-browser-access-token", refresh_token: "radar-browser-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
  user: { id: ownerId, email: "operator@example.test", app_metadata: { role: "operator" }, user_metadata: {}, aud: "authenticated", created_at: "2026-10-01T00:00:00.000Z" },
};
const activeSources = ["domiporta", "olx", "gratka"];
let showObservedOfertyNetOffer = false;
let showConflictingOfertyNetOffer = false;
let showDistrictAssignedOffer = false;
let districtQueueState = { available: false, pending: [], assigned: [], rejected: [] };
const districtQueueAssignments = [];
const districtQueueRejections = [];
function defaultFilters() { return { districts, market: "both", areaMin: null, areaMax: null, rooms: [], sources: [], minPricePerSqm: null, automaticScanEnabled: true, automaticScanTime: "05:00" }; }
function listing(id, marketType) {
  return { id, source: id === "radar-olx" ? "olx" : "domiporta", externalListingId: id, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`, title: `Mieszkanie ${marketType} w bloku — Łódź, ${id}`, description: "Pełny opis źródłowy.", price: 450000, area: 50, pricePerSqm: 9000, rooms: 2, city: "Łódź", district: "Bałuty", buildingType: "blok", marketType, renovationStatus: marketType === "primary" ? "turnkey_finish" : "fresh_renovation", contentHash: id, firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-08T10:00:00.000Z", publishedAt: "2026-10-07T12:00:00.000Z", sourceUpdatedAt: null, collectedAt: "2026-10-08T10:00:00.000Z", crossSourceIdentity: null, crossSourceAlternates: [], status: "active", excludedAt: null, excludedReason: null };
}
function results(filters, excluded = false) {
  if (showDistrictAssignedOffer) {
    const assigned = {
      ...listing("radar-district-queue-assigned", "secondary"),
      district: "Widzew",
      title: "Kandydat przypisany z kolejki dzielnic",
      crossSourceAlternates: [],
    };
    return { listings: [assigned], excludedListings: [], stats: [{ district: "Widzew", marketType: "secondary", qualityCategory: "fresh_renovation", averagePricePerSqm: null, medianPricePerSqm: null, sampleSize: 1, isSmallSample: true, updatedAt: assigned.lastSeenAt }] };
  }
  if (showConflictingOfertyNetOffer) {
    const offer = {
      ...listing("radar-oferty-net-1543068412", "secondary"), source: "oferty_net", externalListingId: "1543068412",
      originalUrl: "https://www.oferty.net/of,1543068412", normalizedUrl: "https://www.oferty.net/of,1543068412",
      title: "Mieszkanie na sprzedaż — Zawiszy Czarnego, Bałuty-Doły, Łódź",
      description: "Na sprzedaż mieszkanie o powierzchni 45 m², położone na parterze na łódzkim Teofilowie. Lokal przeszedł generalny remont i jest gotowy do wprowadzenia.",
      price: 549000, area: 57, pricePerSqm: 549000 / 57, rooms: 3,
      verificationIssues: ["area", "floor", "location"],
    };
    return { listings: [offer], excludedListings: [], stats: [] };
  }
  if (showObservedOfertyNetOffer) {
    const offer = {
      ...listing("radar-oferty-net-1543068412", "secondary"), source: "oferty_net", externalListingId: "1543068412",
      originalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-teofilw-45m2-2-pokoje-419000-pln-fb,1543068412",
      normalizedUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-teofilw-45m2-2-pokoje-419000-pln-fb,1543068412",
      title: "Mieszkanie na sprzedaż — Łanowa, Teofilów, Bałuty, Łódź",
      description: "45 m², 2 pokoje, blok. Rynek wtórny. Generalny remont, lokal niezamieszkany po remoncie, gotowy do wprowadzenia. Także pod wynajem.",
      price: 419000, area: 45, pricePerSqm: 419000 / 45, rooms: 2, city: "Łódź", district: "Bałuty",
      crossSourceIdentity: null, crossSourceAlternates: [],
    };
    return {
      listings: [offer], excludedListings: [],
      stats: [{ district: "Bałuty", marketType: "secondary", averagePricePerSqm: null, medianPricePerSqm: null, sampleSize: 1, isSmallSample: true, updatedAt: offer.lastSeenAt }],
    };
  }
  const domiporta = listing("radar-domiporta", "secondary");
  domiporta.crossSourceIdentity = "portal_shared_unit_id:unit-secondary";
  domiporta.crossSourceAlternates = [{ id: "radar-gratka", source: "gratka", originalUrl: "https://example.test/radar-gratka", title: "Kopia Gratka", price: 455000, area: 50.5, rooms: 2, publishedAt: "2026-10-06T10:00:00.000Z", sourceUpdatedAt: null, collectedAt: "2026-10-08T09:00:00.000Z" }];
  const pool = [domiporta, listing("radar-olx", "primary")];
  const narrowed = pool.filter((item) => filters.market === "both" || item.marketType === filters.market);
  const selected = filters.sources.length ? narrowed.filter((item) => filters.sources.includes(item.source) || item.crossSourceAlternates.some((alternate) => filters.sources.includes(alternate.source))) : narrowed;
  const stats = selected.map((item) => ({ district: item.district, marketType: item.marketType, averagePricePerSqm: null, medianPricePerSqm: null, sampleSize: 1, isSmallSample: true, updatedAt: item.lastSeenAt }));
  const excludedListings = excluded ? selected.slice(0, 1).map((item) => ({ ...item, excludedAt: "2026-10-08T11:00:00.000Z", excludedReason: "ręcznie" })) : [];
  return { listings: excluded ? selected.slice(1) : selected, excludedListings, stats };
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

test("real Radar page persists settings, separates markets, excludes/restores listings, and has no horizontal overflow", { timeout: 600_000 }, async (t) => {
  showDistrictAssignedOffer = false;
  districtQueueState = { available: false, pending: [], assigned: [], rejected: [] };
  districtQueueAssignments.length = 0;
  districtQueueRejections.length = 0;
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
  // Only a small, explicit environment is passed to Next. It cannot inherit secrets
  // or read the developer's .env.local because the runner uses an isolated copy.
  // NODE_ENV=test is intentional: Next.js does not load .env.local in test mode.
  // The runner passes only this loopback Supabase mock and never inherits secrets.
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
  const page = await browser.newPage();
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(session), url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: "Lax" }]);

  const blockedExternalRequests = [];
  await page.route("**/*", async (route) => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") return route.continue();
    blockedExternalRequests.push(route.request().url());
    return route.abort();
  });

  let savedFilters = defaultFilters();
  let excluded = false;
  let failNextSave = false;
  let radarRun = null;
  let nextStopFailure = null;
  let nextTerminationFailure = null;
  const requests = [];
  await page.route("**/api/price-radar/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, method: request.method(), ...(request.method() === "POST" ? { body: request.postDataJSON() } : {}) });
    if (url.pathname === "/api/price-radar/settings" && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: savedFilters, activeSources, disabledSourceNote: "Wyłączone portale pozostają nieaktywne." }) });
    if (url.pathname === "/api/price-radar/settings" && request.method() === "PUT") {
      if (failNextSave) { failNextSave = false; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Błąd zapisu ustawień." }) }); }
      savedFilters = JSON.parse(request.postData() || "{}").filters;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: savedFilters }) });
    }
    if (url.pathname === "/api/price-radar/results") {
      const queryMarket = url.searchParams.get("market");
      const queryFilters = {
        ...savedFilters,
        market: ["both", "secondary", "primary"].includes(queryMarket) ? queryMarket : savedFilters.market,
        sources: url.searchParams.getAll("source"),
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(results(queryFilters, excluded)) });
    }
    if (url.pathname === "/api/price-radar/district-queue" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(districtQueueState) });
    }
    if (url.pathname === "/api/price-radar/district-queue/assign" && request.method() === "POST") {
      const body = request.postDataJSON();
      districtQueueAssignments.push(body);
      const item = districtQueueState.pending.find((candidate) => candidate.id === body.queueId);
      if (!item || !districts.includes(body.district)) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "assignment rejected" }) });
      districtQueueState = {
        ...districtQueueState,
        pending: districtQueueState.pending.filter((candidate) => candidate.id !== item.id),
        assigned: [...districtQueueState.assigned, { ...item, status: "assigned", assignedDistrict: body.district }],
      };
      showDistrictAssignedOffer = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, listingId: "radar-district-queue-assigned" }) });
    }
    if (url.pathname === "/api/price-radar/district-queue/reject" && request.method() === "POST") {
      const body = request.postDataJSON();
      districtQueueRejections.push(body);
      const item = body.rejected === false
        ? districtQueueState.rejected.find((candidate) => candidate.id === body.queueId)
        : districtQueueState.pending.find((candidate) => candidate.id === body.queueId);
      if (!item) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "queue item not found" }) });
      if (body.rejected === false) {
        districtQueueState = {
          ...districtQueueState,
          rejected: districtQueueState.rejected.filter((candidate) => candidate.id !== item.id),
          pending: [...districtQueueState.pending, { ...item, status: "pending", rejectedAt: null }],
        };
      } else {
        districtQueueState = {
          ...districtQueueState,
          pending: districtQueueState.pending.filter((candidate) => candidate.id !== item.id),
          rejected: [...districtQueueState.rejected, { ...item, status: "rejected", rejectedAt: new Date().toISOString() }],
        };
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === "/api/price-radar/run" && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: radarRun }) });
    if (url.pathname === "/api/price-radar/run" && request.method() === "POST") {
      const body = request.postDataJSON() || {};
      if (body.action === "terminate" && nextTerminationFailure) {
        const failure = nextTerminationFailure;
        nextTerminationFailure = null;
        return route.fulfill({ status: failure.status, contentType: "application/json", body: JSON.stringify(failure.body) });
      }
      if (body.action === "terminate" && radarRun?.id === body.runId && (radarRun.status === "running" || radarRun.status === "pending" || radarRun.errorMessage === "RADAR_STOPPED_BY_OPERATOR")) {
        const userTerminatedAt = new Date().toISOString();
        radarRun = { ...radarRun, status: "partial", userTerminatedAt, finishedAt: userTerminatedAt, leaseUntil: null,
          sourceStatuses: Object.fromEntries(Object.entries(radarRun.sourceStatuses || {}).map(([source, status]) => [source, status === "running" ? "pending" : status])) };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: radarRun.id, status: "terminated" }) });
      }
      if (body.action === "start_new" && radarRun?.userTerminatedAt) {
        radarRun = { id: "radar-new-after-terminal-run", status: "running", startedAt: new Date().toISOString(), finishedAt: null,
          leaseUntil: new Date(Date.now() + 120000).toISOString(), stopRequestedAt: null, userTerminatedAt: null, scannedCount: 0,
          qualifiedCount: 0, sourceStatuses: { domiporta: "running" }, sourceErrors: {}, errorMessage: null,
          checkpoint: { sourceQueue: ["domiporta"], currentSourceIndex: 0 } };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: radarRun.id, status: "running" }) });
      }
      if (body.action === "stop" && nextStopFailure) {
        const failure = nextStopFailure;
        nextStopFailure = null;
        return route.fulfill({ status: failure.status, contentType: "application/json", body: JSON.stringify(failure.body) });
      }
      if (body.action === "stop" && radarRun?.id === body.runId && (radarRun.status === "running" || radarRun.status === "pending")) {
        radarRun = { ...radarRun, stopRequestedAt: new Date().toISOString() };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: radarRun.id, status: "stopping" }) });
      }
      if (body.expectedRunId && radarRun?.id === body.expectedRunId && radarRun.errorMessage === "RADAR_STOPPED_BY_OPERATOR") {
        radarRun = { ...radarRun, status: "running", errorMessage: null, stopRequestedAt: null, leaseUntil: new Date(Date.now() + 120000).toISOString() };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: radarRun.id, status: "running" }) });
      }
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "run changed" }) });
    }
    if (url.pathname === "/api/price-radar/exclude" && request.method() === "POST") { excluded = JSON.parse(request.postData() || "{}").excluded; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "unexpected Radar request" }) });
  });

  const initialDistrictQueueRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/price-radar/district-queue" && response.request().method() === "GET");
  await page.goto(`http://127.0.0.1:${port}/price-radar`, { waitUntil: "domcontentloaded" });
  const selectPortalAndWaitForSave = async (name) => { const saved = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT"); await page.getByRole("button", { name }).click(); await saved; };
  await page.getByRole("heading", { name: "Radar cen po remoncie", level: 1 }).waitFor();
  assert.ok(await page.getByRole("link", { name: "Radar cen po remoncie" }).count(), "the Radar has a separate navigation entry");
  await page.getByRole("region", { name: "Automatyczne skanowanie" }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Automatyczny skan"]')?.disabled === false);
  assert.equal(await page.getByLabel("Godzina codziennego skanowania").inputValue(), "05:00", "the UI reads the persisted daily time");
  const timeSaved = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await page.getByLabel("Godzina codziennego skanowania").fill("06:35");
  await timeSaved;
  assert.equal(savedFilters.automaticScanTime, "06:35", "the selected Warsaw time is persisted by the existing settings API");
  const disabledSaved = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await page.getByLabel("Automatyczny skan").uncheck();
  await disabledSaved;
  assert.equal(savedFilters.automaticScanEnabled, false, "the scheduler toggle is persisted");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Radar cen po remoncie", level: 1 }).waitFor();
  await page.getByLabel("Automatyczny skan").waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Automatyczny skan"]')?.checked === false && document.querySelector('input[aria-label="Godzina codziennego skanowania"]')?.value === "06:35");
  assert.equal(await page.getByLabel("Automatyczny skan").isChecked(), false, "the disabled state survives a reload");
  assert.equal(await page.getByLabel("Godzina codziennego skanowania").inputValue(), "06:35", "the saved time survives a reload");
  const enabledSaved = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await page.getByLabel("Automatyczny skan").check();
  await enabledSaved;
  assert.equal(savedFilters.automaticScanEnabled, true);
  const queueRead = await initialDistrictQueueRead;
  assert.equal(queueRead.status(), 200, `the dashboard reads queue availability; requests=${JSON.stringify(requests)}`);
  await page.getByText(/Kolejka przypisania dzielnicy jest niedostępna/u).waitFor();
  assert.match(await page.getByText(/Kolejka przypisania dzielnicy jest niedostępna/u).innerText(), /20261011154631_add_radar_district_queue\.sql/u, "the UI states exactly which unapplied migration blocks this queue instance");
  await page.getByText("Mieszkanie secondary w bloku", { exact: false }).waitFor();
  await page.getByText("Mieszkanie primary w bloku", { exact: false }).waitFor();
  assert.equal(await page.locator("a[href^='https://example.test/']").count(), 3, "the confirmed cross-source group retains both concrete portal links");
  assert.ok(await page.getByText("Znaleziono także na: Gratka").count(), "the Radar shows the linked source explicitly");
  const alternateDetails = await page.locator('a[href="https://example.test/radar-gratka"]').innerText();
  assert.match(alternateDetails.normalize("NFKC"), /Gratka \u00b7 Kopia Gratka \u00b7 455\s*000 z\u0142 \u00b7 50\.5 m2/, "alternate price and area remain together as that source-specific values");
  assert.equal(await page.getByText("Średnia zł/m²").count(), 2, "both market groups are visibly independent");
  assert.equal(await page.getByText("Niewystarczająca próba").count(), 2);
  assert.equal(await page.getByText(/brak ceny referencyjnej \(minimum 10\)/).count(), 2, "the UI reports the current configured sample threshold");

  await page.getByLabel("Rynek").selectOption("secondary");
  await page.getByText("Mieszkanie secondary w bloku", { exact: false }).waitFor();
  await page.waitForFunction(() => document.body.textContent?.includes("Mieszkanie secondary w bloku") && !document.body.textContent?.includes("Mieszkanie primary w bloku"));
  await page.getByLabel("Rynek").selectOption("primary");
  await page.waitForFunction(() => document.body.textContent?.includes("Mieszkanie primary w bloku") && !document.body.textContent?.includes("Mieszkanie secondary w bloku"));

  const districtSave = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "Bałuty" }).click();
  await districtSave;
  assert.ok(requests.some((request) => request.path === "/api/price-radar/settings" && request.method === "PUT"), "changed filters persist through the settings API");
  assert.deepEqual(savedFilters.districts.includes("Bałuty"), false, "the changed setting was saved");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Radar cen po remoncie", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Bałuty" }).waitFor();
  await page.waitForFunction((district) => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === district && button.getAttribute("aria-pressed") === "false"), districts[0]);
  assert.equal(await page.getByRole("button", { name: "Bałuty" }).getAttribute("aria-pressed"), "false", "the saved district selection is restored after a page reload");
  await page.waitForFunction(() => document.querySelector("#price-radar-market")?.value === "primary");
  assert.equal(await page.getByLabel("Rynek").inputValue(), "primary", "the saved market selection is restored after a page reload");

  await page.getByLabel("Rynek").selectOption("both");
  await page.waitForTimeout(650);
  await selectPortalAndWaitForSave("Domiporta");
  await page.waitForTimeout(650);
  assert.deepEqual(savedFilters.sources, ["domiporta"], "a portal selection is saved as a durable Radar filter");
  await page.waitForFunction(() => document.body.textContent?.includes("Mieszkanie secondary w bloku") && !document.body.textContent?.includes("Mieszkanie primary w bloku"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Radar cen po remoncie", level: 1 }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Domiporta" }).getAttribute("aria-pressed"), "true", "the selected portal survives a page reload");
  await selectPortalAndWaitForSave("Domiporta");
  await page.waitForTimeout(300);
  await selectPortalAndWaitForSave("Gratka");
  await page.waitForTimeout(300);
  assert.deepEqual(savedFilters.sources, ["gratka"], "the alternate portal can be selected without changing the representative listing");
  assert.ok(await page.getByText("Mieszkanie secondary w bloku", { exact: false }).count(), "the confirmed group remains visible when filtering by its alternate source");

  await page.getByRole("button", { name: "Wyklucz z porównań" }).first().click();
  await page.getByText(/Wykluczone z porównań/).waitFor();
  assert.ok(requests.some((request) => request.path === "/api/price-radar/exclude" && request.method === "POST"));
  await page.getByRole("button", { name: "Przywróć do porównań" }).first().click();
  await page.getByRole("button", { name: "Wyklucz z porównań" }).first().waitFor();

  failNextSave = true;
  await page.getByLabel("Rynek").selectOption("both");
  await page.getByText("Ustawienia nie zostały zapisane", { exact: false }).waitFor();

  showObservedOfertyNetOffer = true;
  savedFilters.sources = [];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mieszkanie na sprzedaż — Łanowa, Teofilów, Bałuty, Łódź" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Oferty w próbie (1)" }).count(), 1, "the current offer is rendered as one card from the API response");
  const lanowaCardText = await page.locator("article").innerText();
  assert.match(lanowaCardText, /Bałuty, Łódź.*Wtórny.*Blok/u);
  assert.match(lanowaCardText, /419[\s\u00a0]*000\s*zł/u);
  assert.match(lanowaCardText, /45\s*m².*2\s*pok/u);
  assert.equal(await page.locator(`a[href="https://www.oferty.net/mieszkanie-na-sprzedaz-bauty-teofilw-45m2-2-pokoje-419000-pln-fb,1543068412"]`).count(), 1, "the visible card links to the exact observed portal offer");
  showObservedOfertyNetOffer = false;
  showConflictingOfertyNetOffer = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Oferty w próbie (0)" }).waitFor();
  await page.getByText("Do weryfikacji · poza próbą A/B (1)").waitFor();
  await page.getByText("Wymaga weryfikacji · poza próbą A/B").waitFor();
  await page.getByText("Sprzeczne dane: metraż, piętro, lokalizacja.", { exact: false }).waitFor();
  assert.equal(await page.getByText("Średnia zł/m²").count(), 0, "a visible unresolved offer does not create an A/B statistic group");
  assert.equal(await page.getByRole("heading", { name: "Oferty w próbie (1)" }).count(), 0, "an offer outside the A/B sample must not inflate the qualified-sample count");
  await page.getByText("0 mieszkań · brak ceny referencyjnej", { exact: false }).waitFor();
  assert.equal(await page.getByText("Niewystarczająca próba").count(), 1, "a genuinely empty current sample is an explicit, reportable zero, not a silently blank section");
  showConflictingOfertyNetOffer = false;
  savedFilters.sources = ["gratka"];
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("a[href^='https://example.test/']").first().waitFor();

  for (const width of [320, 375, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `Radar page must not horizontally overflow at ${width}px; Next server output: ${serverOutput}`);
  }
  const selectedSourceLinks = page.locator("a[href^='https://example.test/']");
  assert.equal(await selectedSourceLinks.count(), 2, "the selected source keeps the group and its linked concrete URL");
  assert.ok((await selectedSourceLinks.evaluateAll((links) => links.map((link) => link.href))).includes("https://example.test/radar-domiporta"));
  assert.ok((await selectedSourceLinks.evaluateAll((links) => links.map((link) => link.href))).includes("https://example.test/radar-gratka"));

  const queueItem = (id) => ({
    id, source: "domiporta", externalListingId: `candidate-${id}`, originalUrl: `https://example.test/${id}`, normalizedUrl: `https://example.test/${id}`,
    title: `Oferta do przypisania ${id}`, description: "Blok na Teofilowie.", price: 419000, area: 45, pricePerSqm: 419000 / 45, rooms: 2,
    city: "Łódź", buildingType: "blok", marketType: "secondary", renovationStatus: "fresh_renovation", qualityCategory: "fresh_renovation",
    firstSeenAt: "2026-10-11T10:00:00.000Z", lastSeenAt: "2026-10-11T10:00:00.000Z", publishedAt: null, sourceUpdatedAt: null,
    collectedAt: "2026-10-11T10:00:00.000Z", status: "pending", suggestedDistrict: "Bałuty", suggestionSource: "ai",
    suggestionEvidence: "Opis zawiera nazwę Teofilów.", assignedDistrict: null, assignedAt: null, rejectedAt: null,
  });
  districtQueueState = { available: true, pending: [queueItem("queue-assign"), queueItem("queue-reject")], assigned: [], rejected: [] };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Do przypisania dzielnicy (2)" }).waitFor();
  await page.getByText(/Podpowiedź \(AI\): Bałuty.*Teofilów/u).first().waitFor();
  await page.getByRole("button", { name: "Odrzuć" }).first().click();
  await page.getByRole("heading", { name: "Do przypisania dzielnicy (1)" }).waitFor();
  await page.getByText("Odrzucone z kolejki dzielnic (1)").waitFor();
  assert.deepEqual(districtQueueRejections.at(-1), { queueId: "queue-assign", rejected: true }, "operator rejection is an explicit queue write");
  await page.getByRole("button", { name: "Przywróć do kolejki" }).click();
  await page.getByRole("heading", { name: "Do przypisania dzielnicy (2)" }).waitFor();
  await page.locator("#district-queue-select-queue-assign").selectOption("Widzew");
  await page.locator("article").filter({ hasText: "Oferta do przypisania queue-assign" }).getByRole("button", { name: "Dodaj do porównań" }).click();
  await page.getByRole("heading", { name: "Kandydat przypisany z kolejki dzielnic" }).waitFor();
  await page.getByRole("heading", { name: "Do przypisania dzielnicy (1)" }).waitFor();
  await page.getByText("1 mieszkanie · brak ceny referencyjnej", { exact: false }).waitFor();
  assert.deepEqual(districtQueueAssignments, [{ queueId: "queue-assign", district: "Widzew" }], "operator chose one of the allowed districts; the AI suggestion was not applied automatically");
  assert.deepEqual(districtQueueRejections, [{ queueId: "queue-assign", rejected: true }, { queueId: "queue-assign", rejected: false }], "the UI supports rejection and explicit restore without assignment");
  assert.equal(await page.getByText("Do weryfikacji · poza próbą A/B (0)").count(), 0, "the assigned candidate is reloaded through the results API instead of only moving its queue badge");
  assert.deepEqual(blockedExternalRequests, [], "the isolated browser never contacts a portal or remote Supabase");
  const runPosts = () => requests.filter((request) => request.path === "/api/price-radar/run" && request.method === "POST");
  assert.equal(runPosts().length, 0, "viewing and refreshing the page never starts or resumes a collection run");

  const stoppedRunId = "radar-stop-browser-run";
  radarRun = { id: stoppedRunId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, leaseUntil: new Date(Date.now() + 120000).toISOString(), stopRequestedAt: null, userTerminatedAt: null, scannedCount: 17, qualifiedCount: 1, sourceStatuses: { domiporta: "running" }, sourceErrors: {}, errorMessage: null, checkpoint: { sourceQueue: ["domiporta"], currentSourceIndex: 0 } };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Zatrzymaj" }).waitFor();
  assert.equal(runPosts().length, 0, "the active run is discovered by GET without starting another run");
  nextStopFailure = { status: 409, body: { code: "not_active", message: "Serwer nie przyjął STOP dla aktywnego przebiegu." } };
  await page.getByRole("button", { name: "Zatrzymaj" }).first().click();
  await page.getByText(/not_active/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Zatrzymaj" }).count(), 1, "a rejected server response does not optimistically change the UI to stopping");
  assert.equal(radarRun.stopRequestedAt, null, "a rejected write leaves the authoritative run state unchanged");
  nextStopFailure = { status: 500, body: { code: "RADAR_RUN_STOP_FAILED", message: "Nie udało się zapisać STOP." } };
  await page.getByRole("button", { name: "Zatrzymaj" }).first().click();
  await page.getByText(/RADAR_RUN_STOP_FAILED/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Zatrzymaj" }).count(), 1, "a failed persistence response is shown without a false stopping state");
  assert.equal(radarRun.stopRequestedAt, null);
  await page.getByRole("button", { name: "Zatrzymaj" }).first().click();
  const stoppingButtons = page.getByRole("button", { name: "Zatrzymywanie…" });
  await stoppingButtons.first().waitFor();
  assert.equal(await stoppingButtons.count(), 2, "the run controls reflect the same pending stop request");
  assert.deepEqual(await stoppingButtons.evaluateAll((buttons) => buttons.map((button) => (button).disabled)), [true, true], "a pending stop cannot be submitted twice");
  assert.equal(runPosts().length, 3);
  assert.deepEqual(runPosts().map((request) => request.body), [
    { action: "stop", runId: stoppedRunId },
    { action: "stop", runId: stoppedRunId },
    { action: "stop", runId: stoppedRunId },
  ]);
  assert.equal(radarRun.status, "running", "the UI reports stopping, not stopped, until the backend acknowledges it");

  radarRun = { ...radarRun, status: "partial", errorMessage: "RADAR_STOPPED_BY_OPERATOR", finishedAt: new Date().toISOString(), leaseUntil: null };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Wznów zatrzymany przebieg" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Zakończ przebieg" }).count(), 1, "a paused-but-resumable run also offers permanent end separately from STOP");
  assert.ok(await page.getByText(/Zatrzymany/).count(), "the acknowledged backend state is rendered as stopped");
  const postsBeforeStoppedRefresh = runPosts().length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Wznów zatrzymany przebieg" }).waitFor();
  assert.equal(runPosts().length, postsBeforeStoppedRefresh, "refreshing a stopped run does not resume it automatically");

  await page.getByRole("button", { name: "Wznów zatrzymany przebieg" }).click();
  await page.getByRole("button", { name: "Zatrzymaj" }).waitFor();
  const stopResumePosts = runPosts();
  assert.equal(stopResumePosts.length, postsBeforeStoppedRefresh + 1, "resume happens only after the explicit operator click");
  assert.deepEqual(stopResumePosts.at(-1)?.body, { expectedRunId: stoppedRunId }, "resume continues the same scan_run_id");
  assert.equal(radarRun.id, stoppedRunId, "resume cannot allocate a new run ID");

  nextTerminationFailure = { status: 500, body: { code: "RADAR_RUN_TERMINATION_FAILED", message: "Nie udało się zapisać końca." } };
  await page.getByRole("button", { name: "Zakończ przebieg" }).click();
  await page.getByText(/RADAR_RUN_TERMINATION_FAILED/).waitFor();
  assert.equal(radarRun.userTerminatedAt, null, "a failed server write does not optimistically mark the run ended");
  assert.equal(await page.getByRole("button", { name: "Zakończ przebieg" }).count(), 1, "the failed response leaves the operation available for a deliberate retry");

  const terminationsBeforeSuccess = runPosts().filter((request) => request.body?.action === "terminate").length;
  await page.getByRole("button", { name: "Zakończ przebieg" }).click();
  await page.getByText("Zakończony przez użytkownika", { exact: true }).waitFor();
  assert.ok(radarRun.userTerminatedAt, "the browser only shows the terminal state after the server confirms it");
  assert.equal(radarRun.id, stoppedRunId, "termination preserves the run ID");
  assert.equal(radarRun.scannedCount, 17);
  assert.equal(radarRun.qualifiedCount, 1);
  assert.equal(radarRun.sourceStatuses.domiporta, "pending", "unfinished source work is not reported as completed");
  assert.equal(await page.getByRole("button", { name: "Zakończ przebieg" }).count(), 0, "a terminal run cannot be ended again through a stale UI state");
  assert.equal(await page.getByRole("button", { name: "Uruchom nowy przebieg" }).count(), 1, "the next start is explicitly a new run, never a resume of this ID");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Zakończony przez użytkownika", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Uruchom nowy przebieg" }).count(), 1, "the terminal state and end date survive a full page refresh");
  assert.equal(runPosts().filter((request) => request.body?.action === "terminate").length, terminationsBeforeSuccess + 1, "refresh reads terminal state but does not repeat the terminal write");
  assert.equal(runPosts().filter((request) => request.body?.expectedRunId === stoppedRunId).length, 1, "refreshing an ended run never resumes its old ID");
  await page.getByRole("button", { name: "Uruchom nowy przebieg" }).click();
  await page.getByRole("button", { name: "Zatrzymaj" }).waitFor();
  assert.deepEqual(runPosts().at(-1)?.body, { action: "start_new" }, "a terminal run with the old stop marker starts explicitly instead of trying to resume its ID");
  assert.equal(radarRun.id, "radar-new-after-terminal-run", "the explicit start creates a distinct run ID");
  assert.equal(await page.getByText(/The requested Radar run is no longer resumable/u).count(), 0, "starting a new run clears the stale resumability error");
});

test("an expired nonterminal Radar run resumes automatically in place without a manual click", { timeout: 600_000 }, async (t) => {
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
  // Match the first browser case: the test environment suppresses .env.local.
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
  const page = await browser.newPage();
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(session), url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: "Lax" }]);

  // Reproduces the real Production state observed on 2026-10-09: the OLX job
  // died through claim_olx_scan_job's own generic LEASE_EXHAUSTED path, which
  // never updates price_radar_runs -- the run row is left at status "running"
  // with a lease_until already in the past.
  const orphanedRun = {
    id: "93a7f1d5-0000-4000-8000-000000000001", status: "running", startedAt: "2026-10-09T20:50:06.000Z", finishedAt: null,
    leaseUntil: new Date(Date.now() - 5 * 60_000).toISOString(),
    scannedCount: 29, qualifiedCount: 0,
    sourceStatuses: { otodom: "failed", olx: "failed", morizon: "pending" },
    sourceErrors: {},
    sourceWarnings: { otodom: ["Otodom: duplicate (1)", "Otodom: unsupported_listing (2)"] },
    sourceRejectionCounts: { otodom: { duplicate: 1, unsupported_listing: 2 } },
    qualificationRejections: { olx: { district_not_confirmed: 7, building_type_not_confirmed: 3 } },
    checkpoint: { sourceQueue: ["morizon"], currentSourceIndex: 0, rejectedCount: 12, verificationQueuedCount: 4, districtQueuedCount: 2 },
    errorMessage: null,
  };
  let postCount = 0;
  const resumedRunIds = [];
  await page.route("**/api/price-radar/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/price-radar/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filters: defaultFilters(), activeSources, disabledSourceNote: "" }) });
    if (url.pathname === "/api/price-radar/results") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listings: [], excludedListings: [], stats: [] }) });
    if (url.pathname === "/api/price-radar/run" && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: orphanedRun }) });
    if (url.pathname === "/api/price-radar/run" && request.method() === "POST") {
      postCount += 1;
      resumedRunIds.push(request.postDataJSON()?.expectedRunId ?? null);
      orphanedRun.status = "partial";
      orphanedRun.finishedAt = new Date().toISOString();
      orphanedRun.leaseUntil = null;
      orphanedRun.sourceStatuses.morizon = "failed";
      orphanedRun.sourceErrors.morizon = "OFFLINE_FIXTURE_FAILURE";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runId: orphanedRun.id, status: "partial", scannedCount: 29, qualifiedCount: 0 }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "unexpected Radar request" }) });
  });

  await page.goto(`http://127.0.0.1:${port}/price-radar`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Radar cen po remoncie", level: 1 }).waitFor();
  // Settings load asynchronously and gate the button too (disabled={... || !settingsLoaded}).
  // Wait for a settings-derived element so this test's own assertion isn't racing that load.
  await page.getByRole("button", { name: districts[0] }).waitFor();
  // The run status arrives via its own async fetch after settings load. Wait
  // for its resulting, run-derived text before reading the button's state,
  // so this assertion isn't racing that fetch's resolution.
  await page.getByText("Zakończono częściowo", { exact: true }).waitFor();
  await page.waitForFunction(() => document.body.textContent?.includes("OFFLINE_FIXTURE_FAILURE"));
  const automationSummary = await page.getByRole("region", { name: "Automatyczne skanowanie" }).innerText();
  assert.match(automationSummary, /Sprawdzono\s+29/u);
  assert.match(automationSummary, /Zakwalifikowano\s+0/u);
  assert.match(automationSummary, /Odrzucono\s+12/u);
  assert.match(automationSummary, /Skierowano do weryfikacji\s+6/u);
  const rejectionDetails = page.getByLabel("Powody odrzucenia ofert");
  await rejectionDetails.locator("summary").click();
  await page.getByText("brak potwierdzonej dzielnicy Łodzi · 7", { exact: false }).waitFor();
  await page.getByText("brak potwierdzonego typu budynku · 3", { exact: false }).waitFor();
  const sourceRejections = page.getByLabel("Odrzucone kandydatury źródeł");
  await sourceRejections.locator("summary").click();
  await page.getByText("duplikat w wynikach źródła · 1", { exact: false }).waitFor();
  await page.getByText("nieobsługiwany typ ogłoszenia · 2", { exact: false }).waitFor();
  assert.equal(postCount, 1, "a stale nonterminal run is automatically continued without a manual click");
  assert.deepEqual(resumedRunIds, [orphanedRun.id], "auto-resume is bound to the same run ID, never to a new run request");
  assert.equal(orphanedRun.id, "93a7f1d5-0000-4000-8000-000000000001", "the current run identity remains unchanged");
  await page.getByRole("button", { name: "Uruchom / wznów zbieranie" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Uruchamianie…" }).count(), 0, "the automatic resume must release the UI's busy state after the terminal response");
  assert.equal(serverOutput.includes("Error:"), false, serverOutput);
});
