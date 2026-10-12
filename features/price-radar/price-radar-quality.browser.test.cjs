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
  const offlinePreload = path.resolve(root, "features/test-support/offline-next.cjs");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: "test",
    NODE_OPTIONS: `--use-system-ca --require=${offlinePreload}`,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "price-radar-browser-test-key",
  };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build", "--webpack"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const verificationDecisionPosts = [];
  const verificationCandidate = {
    id: "verification-offer-42", source: "oferty_net", externalListingId: "offer-42",
    originalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-lodz-42m2,offer-42",
    title: "Mieszkanie do ręcznego sprawdzenia — Łódź",
    status: "pending", firstSeenAt: "2026-10-10T09:00:00Z", lastSeenAt: "2026-10-10T12:00:00Z",
    snapshot: {
      description: "Pojedyncze mieszkanie na sprzedaż. Sprawdź cenę i metraż w źródle.", price: 400_000,
      pricePerSqm: null, area: 40, rooms: 2, city: null, district: null, buildingType: null, marketType: null,
      qualityCategory: null, publishedAt: null, sourceUpdatedAt: null, collectedAt: "2026-10-10T12:00:00Z",
      sourceHttpStatus: 200, finalUrl: "https://www.oferty.net/mieszkanie-na-sprzedaz-lodz-42m2,offer-42?detail=1", sourceIdentity: "same_listing_id",
      confirmedFields: [], missingFields: ["total_price", "area", "rooms", "city_lodz", "district", "building_type", "market_type", "standard"],
      contradictoryFields: ["area"],
      fieldEvidence: { total_price: "Cena wymaga sprawdzenia.", area: "Sprzeczne wartości powierzchni.", rooms: "Brak potwierdzenia." },
      routingReasons: ["detail_conflict", "missing:standard"], suggestedDistrict: "Bałuty", suggestionEvidence: "Źródłowy cytat z lokalizacją: Bałuty, Łódź.",
    }, decision: null, decisionAt: null, rejectedAt: null,
  };
  const secondVerificationCandidate = {
    ...verificationCandidate, id: "verification-offer-rejected", externalListingId: "offer-rejected",
    originalUrl: "https://www.oferty.net/of,offer-rejected", title: "Oferta do odrzucenia z kolejki",
  };
  let verificationQueue = { available: true, pending: [verificationCandidate], confirmed: [], rejected: [] };
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
  await page.route("**/api/price-radar/verification-queue", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(verificationQueue) });
    }
    return route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ message: "method not allowed" }) });
  });
  await page.route("**/api/price-radar/verification-queue/resolve", async (route) => {
    const body = route.request().postDataJSON();
    verificationDecisionPosts.push(body);
    if (body.queueId !== verificationCandidate.id || body.decision?.apartmentSaleConfirmed !== true) {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "explicit confirmation required" }) });
    }
    // The operator's saved minimum price/m2 (8 800 zł/m²) is re-checked
    // server-side on every confirm attempt -- a sub-threshold decision is
    // refused, the card must stay in the pending queue, never silently
    // approved just because the operator typed it in by hand.
    const decisionPricePerSqm = body.decision.price / body.decision.area;
    if (decisionPricePerSqm < 8_800) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Oferta po ponownej kwalifikacji nie spełnia kryteriów Radaru.", reason: "price_per_sqm_below_minimum" }) });
    }
    const decision = { ...body.decision, confirmedAt: new Date().toISOString() };
    verificationQueue = {
      available: true, pending: [], rejected: [],
      confirmed: [{ ...verificationCandidate, status: "confirmed", decision, decisionAt: decision.confirmedAt }],
    };
    all.push({
      ...listing("verified-from-queue", 10_000, "ready_high_standard", "turnkey_finish"),
      source: "oferty_net", externalListingId: "offer-42", originalUrl: verificationCandidate.originalUrl,
      title: "Mieszkanie ręcznie potwierdzone z kolejki", price: 400_000, area: 40, pricePerSqm: 10_000,
      city: "Łódź", district: "Bałuty", buildingType: "blok", marketType: "secondary", rooms: 2,
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, listingId: "verified-from-queue" }) });
  });
  await page.route("**/api/price-radar/verification-queue/reject", async (route) => {
    const body = route.request().postDataJSON();
    const target = [verificationCandidate, secondVerificationCandidate].find((item) => item.id === body.queueId);
    if (!target) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    verificationQueue = { available: true, pending: verificationQueue.pending.filter((item) => item.id !== target.id), confirmed: verificationQueue.confirmed, rejected: [...verificationQueue.rejected, { ...target, status: "rejected", rejectedAt: new Date().toISOString() }] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${baseUrl}/price-radar`);
  await page.locator("article").filter({ hasText: "A · Po świeżym remoncie" }).waitFor();
  await page.locator("article").filter({ hasText: "B · Gotowe — wysoki standard" }).waitFor();
  assert.equal(await page.locator('section[aria-label="Oferty w próbie"] article').count(), 2, "both quality categories retain visible cards below the 20-item threshold; the separate review queue is not counted as a comparison card");
  assert.equal(runPostCount, 0, "viewing the Radar does not start or resume a run");

  const minimum = page.getByLabel("Min. cena ofertowa za m²");
  const settingsSave = page.waitForResponse((response) => response.url().includes("/api/price-radar/settings") && response.request().method() === "PUT");
  await minimum.fill("9500");
  await settingsSave;
  await page.locator("article").filter({ hasText: "A · Po świeżym remoncie" }).waitFor();
  await page.getByText("Oferty w próbie (1)").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Min. cena ofertowa za m²").waitFor();
  await page.waitForFunction(() => document.querySelector("#price-radar-min-price-per-sqm")?.value === "9500");
  assert.equal(await minimum.inputValue(), "9500", "the saved threshold survives refresh");
  await page.getByRole("button", { name: "Wyklucz z porównań" }).click();
  await page.getByText("Oferty w próbie (0)").waitFor();
  await page.getByText("Wykluczone z porównań (1)").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Wykluczone z porównań (1)").waitFor();
  await page.getByRole("button", { name: "Przywróć do porównań" }).click();
  await page.getByText("Oferty w próbie (1)").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Oferty w próbie (1)").waitFor();

  await page.getByRole("heading", { name: "Do weryfikacji danych i standardu (1)" }).waitFor();
  // The simplified card must show only the operator-facing fields -- none
  // of the removed technical evidence/diagnostics/AI-suggestion text.
  assert.equal(await page.getByText("Pola i dowody źródłowe").count(), 0, "technical field-evidence block must no longer render in the main view");
  assert.equal(await page.getByText(/HTTP źródła/u).count(), 0, "source HTTP/identity diagnostics must no longer render in the main view");
  assert.equal(await page.getByText(/Sugestia AI/u).count(), 0, "the AI suggestion text must no longer render in the main view");
  assert.equal(await page.getByText(/Powód skierowania/u).count(), 0, "the routing reason must no longer render in the main view");
  const verificationCard = page.locator('section[aria-label="Do weryfikacji danych i standardu"] article').filter({ hasText: "Mieszkanie do ręcznego sprawdzenia" });
  for (const label of ["Cena całkowita, zł", "Powierzchnia, m²", "Pokoje", "Miasto — potwierdź z ogłoszenia", "Dzielnica", "Typ budynku"]) {
    await verificationCard.getByLabel(label).waitFor();
  }
  await verificationCard.getByRole("checkbox", { name: /Potwierdzam z ogłoszenia/u }).waitFor();
  await verificationCard.getByRole("button", { name: "Potwierdź i dodaj do porównań" }).waitFor();
  await verificationCard.getByRole("button", { name: "Odrzuć" }).waitFor();
  assert.equal(await verificationCard.getByLabel("Cena całkowita, zł").inputValue(), "", "a conflicting source amount is not silently prefilled as confirmed total price");
  assert.equal(await verificationCard.getByLabel("Powierzchnia, m²").inputValue(), "", "a conflicting area is not silently prefilled as confirmed");
  await verificationCard.getByText("Uzupełnij poprawną cenę i metraż").waitFor();

  // 1. A sub-threshold confirm (240 000 zł / 40 m² = 6 000 zł/m², below the
  // saved 8 800 zł/m² minimum) is refused server-side; the card must stay
  // in the visible pending queue with its count unchanged, never silently
  // removed or approved.
  await verificationCard.getByLabel("Cena całkowita, zł").fill("240000");
  await verificationCard.getByLabel("Powierzchnia, m²").fill("40");
  await verificationCard.getByText("6 000 zł/m²", { exact: false }).waitFor();
  await verificationCard.getByLabel("Pokoje").fill("2");
  await verificationCard.getByLabel("Miasto — potwierdź z ogłoszenia").fill("Łódź");
  await verificationCard.getByLabel("Dzielnica").selectOption("Bałuty");
  await verificationCard.getByLabel("Typ budynku").selectOption("blok");
  await verificationCard.locator("label").filter({ hasText: "Rynek" }).locator("select").selectOption("secondary");
  await verificationCard.locator("label").filter({ hasText: "Standard" }).locator("select").selectOption("ready_high_standard");
  await verificationCard.getByRole("checkbox", { name: /Potwierdzam z ogłoszenia/u }).check();
  await verificationCard.getByRole("button", { name: "Potwierdź i dodaj do porównań" }).click();
  await page.getByText(/nie spełnia kryteriów Radaru/u).waitFor();
  await page.getByRole("heading", { name: "Do weryfikacji danych i standardu (1)" }).waitFor();
  assert.equal(await verificationCard.count(), 1, "a refused (sub-threshold) confirm must not remove the card from the queue");

  // 2. Correct the price above the saved minimum -- the read-only price/m²
  // field recalculates live, before the confirm click, then confirm for real.
  await verificationCard.getByLabel("Cena całkowita, zł").fill("400000");
  await verificationCard.getByText("10 000 zł/m²", { exact: false }).waitFor();
  await verificationCard.getByRole("button", { name: "Potwierdź i dodaj do porównań" }).click();
  await page.getByText("Oferty w próbie (2)").waitFor();
  assert.equal(await page.locator('section[aria-label="Do weryfikacji danych i standardu"]').count(), 0, "the section itself disappears once the queue is empty, not just the one card");
  assert.equal(await page.getByText("Mieszkanie do ręcznego sprawdzenia").count(), 0, "a confirmed card must disappear from the visible queue immediately, with no lingering 'confirmed' section");
  assert.equal(await page.getByText(/Potwierdzone i dodane do porównań/u).count(), 0, "no lingering confirmed section in the default view");
  assert.deepEqual(verificationDecisionPosts.at(-1).decision, {
    apartmentSaleConfirmed: true, price: 400000, area: 40, rooms: 2, city: "Łódź", district: "Bałuty",
    buildingType: "blok", marketType: "secondary", qualityCategory: "ready_high_standard",
  }, "the browser sends the explicit operator-selected facts and category B");
  assert.ok(all.some((item) => item.id === "verified-from-queue"), "only after explicit confirmation does the re-read include the Radar comparison");
  assert.equal(await page.getByText("Oferty w próbie (2)").count(), 1, "the newly confirmed offer is visible below the 20-item sample threshold");

  // 3. Reload must not resurrect the already-confirmed card (the mocked
  // GET already reflects the server's post-confirm state, exactly like a
  // real reimport/refresh would).
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Oferty w próbie (2)").waitFor();
  assert.equal(await page.getByText("Mieszkanie do ręcznego sprawdzenia").count(), 0, "refresh must not restore an already-resolved card");

  // 4. Reject a second candidate -- the card and its counter must disappear
  // immediately, with no grayed-out "rejected" card left visible below.
  verificationQueue = { ...verificationQueue, pending: [secondVerificationCandidate] };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Do weryfikacji danych i standardu (1)" }).waitFor();
  const rejectCard = page.locator("article").filter({ hasText: "Oferta do odrzucenia z kolejki" });
  await rejectCard.getByRole("button", { name: "Odrzuć" }).click();
  await page.getByText("Oferta do odrzucenia z kolejki").waitFor({ state: "detached" });
  assert.equal(await page.locator('section[aria-label="Do weryfikacji danych i standardu"]').count(), 0, "the queue section disappears once empty after a reject");
  assert.equal(await page.getByText(/Odrzucone z weryfikacji/u).count(), 0, "no lingering grayed-out rejected section in the default view");

  // 5. Reload must not resurrect the rejected card either.
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByText("Oferta do odrzucenia z kolejki").count(), 0, "refresh must not restore an already-rejected card");

  // 6. Desktop and mobile widths both render without horizontal overflow.
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `Radar should not overflow at ${width}px (overflow ${overflow}px)`);
  }
});
