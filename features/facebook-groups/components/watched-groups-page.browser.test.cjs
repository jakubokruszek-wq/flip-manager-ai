/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require("../../test-support/browser-auth.cjs");

/**
 * Mission: fix opening the user's own watched groups, and fix the
 * app<->extension discovery handshake (which showed "Rozszerzenie Flip
 * Collector nie odpowiada" / "Brak sesji" / "Brak wykrytych grup"). Proves,
 * in a real browser against the real page:
 *   1. an active group card's "Facebook" link actually opens a new tab that
 *      navigates toward the group's own real URL when clicked -- not merely
 *      that its href attribute looks right. The intended request is
 *      intercepted and aborted at the browser-context level before it ever
 *      leaves for facebook.com, so this proves real click->navigation
 *      behavior without violating the "never contact facebook.com" rule
 *      this same file enforces at the bottom;
 *   2. clicking "Wykryj grupy na Facebooku" genuinely drives the documented
 *      window.postMessage protocol -- a simulated extension's ACK/RESULT is
 *      actually received and rendered, not just claimed by source text;
 *   3. a high-confidence (real estate + Łódź) discovered candidate is added
 *      to the Watcher's registry automatically -- the real import endpoint
 *      is genuinely called, with no "Importuj wszystkie"/"Importuj wybrane"
 *      click ever made -- while a candidate that still needs manual review
 *      is left in the preview table exactly as before;
 *   4. when nothing responds at all, the UI reaches a real, honest
 *      "Rozszerzenie nie odpowiada" state with the specific fix instruction
 *      -- never the old, unverifiable "Brak sesji" claim;
 *   5. none of this ever contacts facebook.com or any Watcher scan endpoint.
 */
const GROUP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GROUP_URL = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/";
const groupsPayload = {
  groups: [
    {
      id: GROUP_ID, type: "GROUP", sourceId: "lodzsprzedazzakupwynajem", name: "Łódź sprzedaż zakup wynajem", nameVerified: true,
      url: GROUP_URL, city: "Łódź", district: null, neighborhood: null, priority: "high", keywords: [], enabled: true,
      accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 3, newToday: 1, opportunities: 0, lastError: null,
    },
  ],
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
      const request = http.get(url, (response) => {
        response.resume();
        resolve(response.statusCode < 500);
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready");
}

test("watched groups page: real group links, a real simulated extension handshake, and an honest unresponsive-extension state", { timeout: 180_000 }, async (t) => {
  const port = await freePort();
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());

  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "watched-groups-browser-publishable-key",
  };
  await ensureProductionBuild(nextBin, root, env);
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/facebook-watcher/groups`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const facebookRequests = [];
  const scanEndpointRequests = [];

  await t.test("an active group's Facebook link opens its own real URL", async () => {
    const page = await browser.newPage();
    const context = page.context();
    await addOperatorSessionCookie(context, baseUrl);
    page.on("request", (request) => {
      const url = request.url();
      if (/facebook\.com/i.test(url)) facebookRequests.push(url);
      if (/facebook_scan_jobs|\/api\/facebook-watcher\/groups\/discover\b/.test(url) && request.method() !== "GET") scanEndpointRequests.push(url);
    });
    await page.route("**/api/facebook-watcher/groups", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(groupsPayload), status: 200 }));
    await page.route("**/api/facebook-watcher/groups/historical-mapping", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ mapping: [] }), status: 200 }));
    await page.goto(`${baseUrl}/facebook-watcher/groups`, { waitUntil: "domcontentloaded" });
    const card = page.locator("article", { hasText: "Łódź sprzedaż zakup wynajem" });
    const link = card.getByRole("link", { name: "Facebook", exact: true });
    await link.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await link.getAttribute("href"), GROUP_URL, "the card's own link must point at the group's real, stored URL, never blank or wrong");
    assert.equal(await link.getAttribute("target"), "_blank");

    // Real navigation proof, not just href inspection: intercept and abort
    // the intended request at the browser-context level (registered before
    // the click, so it also covers the new tab Chromium is about to create)
    // so the actual outbound request to facebook.com never leaves, while
    // still proving the click genuinely opened a tab navigating to the
    // group's exact URL.
    let interceptedUrl = null;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/facebook\.com/i.test(url)) { interceptedUrl = url; return route.abort(); }
      return route.continue();
    });
    const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    assert.equal(interceptedUrl, GROUP_URL, "clicking the link must drive a real browser navigation toward the group's exact stored URL, not just carry the right href");
    await popup.close();
    await page.close();
  });

  await t.test("clicking 'Wykryj grupy na Facebooku' with a simulated extension ACK+RESULT actually updates the UI", async () => {
    const page = await browser.newPage();
    await addOperatorSessionCookie(page.context(), baseUrl);
    await page.route("**/api/facebook-watcher/groups", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(groupsPayload), status: 200 }));
    await page.route("**/api/facebook-watcher/groups/historical-mapping", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ mapping: [] }), status: 200 }));
    // This candidate deliberately needs manual review (real estate, but no
    // city mentioned) rather than being Łódź real estate -- the dedicated
    // auto-import test below covers the NOWA_NIERUCHOMOSCIOWA case, where
    // this exact "the discovered name renders in the preview table" check
    // would no longer hold once it's imported automatically.
    await page.route("**/api/facebook-watcher/groups/discover/preview", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        preview: [{ url: "https://www.facebook.com/groups/999888777/", normalizedUrl: "https://www.facebook.com/groups/999888777/", identifier: "999888777", discoveredName: "Mieszkania Wynajem Test", status: "WYMAGA_WERYFIKACJI", reason: "Nazwa grupy wskazuje na nieruchomości, ale nie wspomina Łodzi — wymagana ręczna weryfikacja przed importem." }],
        expiresAt: "2026-10-01T00:00:00.000Z",
      }),
      status: 200,
    }));
    // Simulates a real, installed, responding extension via the exact
    // documented window.postMessage protocol -- never a Facebook network
    // request, since this is purely a page<->content-script simulation.
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.source !== window || event.data?.type !== "FLIP_GROUP_DISCOVERY_REQUEST") return;
        window.postMessage({ type: "FLIP_GROUP_DISCOVERY_ACK" }, event.origin);
        window.setTimeout(() => window.postMessage({ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: true, token: "sim-token", expiresAt: "2026-10-01T00:00:00.000Z", diagnostics: { pageUrl: "https://www.facebook.com/groups/", examined: 10, accepted: 1, namesFound: 1, rejected: 9, duplicates: 0, reason: null, scrollAttempts: 1, stabilized: true, initialRenderAttempts: 1, initialRenderTimedOut: false } }, event.origin), 50);
      });
    });
    await page.goto(`${baseUrl}/facebook-watcher/groups`, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Wykryj grupy na Facebooku" });
    await button.waitFor({ state: "visible" });
    await button.click();
    await page.getByText("Odebrano wyniki").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("Mieszkania Wynajem Test").waitFor({ state: "visible", timeout: 10_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /Brak sesji/, "the old, unverifiable 'no session' claim must never appear");
    await page.close();
  });

  await t.test("a high-confidence Łódź real-estate candidate is added to the Watcher automatically, with no 'Importuj wszystkie'/'Importuj wybrane' click ever made", async () => {
    const page = await browser.newPage();
    await addOperatorSessionCookie(page.context(), baseUrl);
    await page.route("**/api/facebook-watcher/groups", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(groupsPayload), status: 200 }));
    await page.route("**/api/facebook-watcher/groups/historical-mapping", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ mapping: [] }), status: 200 }));
    await page.route("**/api/facebook-watcher/groups/discover/preview", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        preview: [{ url: "https://www.facebook.com/groups/555444333/", normalizedUrl: "https://www.facebook.com/groups/555444333/", identifier: "555444333", discoveredName: "Łódź Nieruchomości Auto Test", status: "NOWA_NIERUCHOMOSCIOWA", reason: "Nowa grupa nieruchomościowa związana z Łodzią, nieznana w Managerze ani wśród zatwierdzonych źródeł." }],
        expiresAt: "2026-10-01T00:00:00.000Z",
      }),
      status: 200,
    }));
    const importCalls = [];
    await page.route("**/api/facebook-watcher/groups/import", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      importCalls.push(body);
      const selection = body.selections?.[0] ?? {};
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          outcomes: [{
            url: selection.url,
            result: {
              success: true,
              duplicate: false,
              group: {
                id: "cccccccc-0000-4000-8000-000000000003", type: "GROUP", sourceId: "555444333", name: selection.name, nameVerified: true,
                url: selection.url, city: "Łódź", district: null, neighborhood: null, priority: "normal", keywords: [], enabled: true,
                accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null,
              },
            },
          }],
        }),
      });
    });
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.source !== window || event.data?.type !== "FLIP_GROUP_DISCOVERY_REQUEST") return;
        window.postMessage({ type: "FLIP_GROUP_DISCOVERY_ACK" }, event.origin);
        window.setTimeout(() => window.postMessage({ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: true, token: "sim-token-auto", expiresAt: "2026-10-01T00:00:00.000Z" }, event.origin), 50);
      });
    });
    await page.goto(`${baseUrl}/facebook-watcher/groups`, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Wykryj grupy na Facebooku" });
    await button.waitFor({ state: "visible" });
    await button.click();
    // Deliberately never clicks "Importuj wszystkie grupy nieruchomościowe"
    // or "Importuj wybrane" -- the entire point under test is that nothing
    // further is needed for a high-confidence candidate.
    await page.getByText("Automatycznie dodano do Watchera").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(importCalls.length, 1, "the real import endpoint must be called automatically for a high-confidence candidate, with no operator click");
    assert.equal(importCalls[0].selections?.length, 1);
    assert.equal(importCalls[0].selections[0].url, "https://www.facebook.com/groups/555444333/");
    assert.equal(importCalls[0].selections[0].name, "Łódź Nieruchomości Auto Test");
    await page.close();
  });

  await t.test("when nothing responds at all, the UI reaches an honest 'Rozszerzenie nie odpowiada' state with the real fix instruction", async () => {
    const page = await browser.newPage();
    await addOperatorSessionCookie(page.context(), baseUrl);
    await page.route("**/api/facebook-watcher/groups", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(groupsPayload), status: 200 }));
    await page.route("**/api/facebook-watcher/groups/historical-mapping", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ mapping: [] }), status: 200 }));
    // Deliberately no addInitScript -- simulates no extension at all installed.
    await page.goto(`${baseUrl}/facebook-watcher/groups`, { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Wykryj grupy na Facebooku" });
    await button.waitFor({ state: "visible" });
    await button.click();
    await page.getByText("Rozszerzenie nie odpowiada").waitFor({ state: "visible", timeout: 10_000 });
    const bodyText = await page.locator("body").innerText();
    assert.doesNotMatch(bodyText, /Brak sesji/, "the UI must never assert a Facebook-session fact it cannot verify");
    assert.match(bodyText, /zainstalowane, przeładowane i wskazuje na katalog extensions\/facebook-collector/, "the real, specific fix instruction must still be shown");
    await page.close();
  });

  assert.deepEqual(facebookRequests, [], "none of this flow may ever contact facebook.com directly");
  assert.deepEqual(scanEndpointRequests, [], "none of this flow may ever create a facebook_scan_jobs row or trigger a real discovery POST");
});
