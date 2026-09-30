/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");
const { addOperatorSessionCookie, ensureProductionBuild, startFakeSupabaseAuthServer } = require("../../features/test-support/browser-auth.cjs");

/**
 * Mission: on a real mobile screen the sidebar/top-bar branding was visibly
 * clipped ("Flip Man...", "Jakub Okr...", "INVESTMEN..."). Proves, in a real
 * browser at the four required viewports, that: the full brand name and
 * signature are always fully present in the DOM; nothing is clipped with an
 * ellipsis on desktop; the compact mobile header never shows a visible "...";
 * opening the mobile menu reveals the complete, unclipped name; the page
 * never overflows horizontally; and the old "Investment OS" subtitle no
 * longer appears as part of the brand mark.
 */
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

// scrollWidth > clientWidth on a text element is exactly what a CSS
// text-overflow: ellipsis clip produces -- this is a real, rendered-layout
// check, not a source-text assumption.
async function assertNotClipped(locator, label) {
  const { scrollWidth, clientWidth, text } = await locator.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    text: el.textContent ?? "",
  }));
  assert.ok(scrollWidth <= clientWidth + 1, `${label} must not be clipped (scrollWidth ${scrollWidth} > clientWidth ${clientWidth})`);
  assert.doesNotMatch(text, /…|\.\.\./, `${label} must not contain a visible ellipsis, got "${text}"`);
}

async function assertNoPageOverflow(page, label) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(scrollWidth <= innerWidth + 1, `${label}: document must not overflow horizontally (scrollWidth ${scrollWidth} > innerWidth ${innerWidth})`);
}

test("Flip Manager by Jakub Okruszek branding is fully visible, unclipped, at every required viewport", { timeout: 180_000 }, async (t) => {
  const port = await freePort();
  const auth = await startFakeSupabaseAuthServer();
  t.after(() => auth.server.close());

  const root = path.resolve(__dirname, "../..");
  const nextBin = require.resolve("next/dist/bin/next");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(),
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: auth.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "branding-browser-publishable-key",
  };
  await ensureProductionBuild(nextBin, root, env);
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/dashboard`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const desktopViewports = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
  const mobileViewports = [{ width: 390, height: 844 }, { width: 768, height: 1024 }];

  for (const viewport of desktopViewports) {
    await t.test(`desktop at ${viewport.width}px: full branding visible in the sidebar, nothing clipped`, async () => {
      const page = await browser.newPage({ viewport });
      await addOperatorSessionCookie(page.context(), baseUrl);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      const brand = page.locator('[data-testid="desktop-sidebar"] [data-testid="product-brand"]');
      await brand.waitFor({ state: "visible", timeout: 20_000 });

      const brandText = await brand.innerText();
      assert.match(brandText, /Flip Manager/);
      assert.match(brandText, /Jakub Okruszek/);
      assert.doesNotMatch(brandText, /Investment OS/, "the old Investment OS subtitle must not appear as part of the brand mark");

      await assertNotClipped(brand.locator("text=Flip Manager").first(), "the Flip Manager name");
      await assertNotClipped(brand.getByLabel("Jakub Okruszek"), "the Jakub Okruszek signature");
      await assertNoPageOverflow(page, `desktop ${viewport.width}px`);
      await page.close();
    });
  }

  for (const viewport of mobileViewports) {
    await t.test(`mobile at ${viewport.width}px: compact header has no visible "...", full name appears once the menu opens`, async () => {
      const page = await browser.newPage({ viewport });
      await addOperatorSessionCookie(page.context(), baseUrl);
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });

      const compactBrand = page.locator("header p").filter({ hasText: "Flip Manager" }).first();
      await compactBrand.waitFor({ state: "visible", timeout: 20_000 });
      const compactText = await compactBrand.innerText();
      assert.doesNotMatch(compactText, /…|\.\.\./, `the compact mobile header must not show a visible ellipsis, got "${compactText}"`);
      const fullNameAttr = await compactBrand.evaluate((el) => el.getAttribute("aria-label") ?? el.getAttribute("title"));
      assert.equal(fullNameAttr, "Flip Manager by Jakub Okruszek", "the full name must be available via aria-label/title even in compact form");
      await assertNoPageOverflow(page, `mobile ${viewport.width}px, menu closed`);

      await page.getByRole("button", { name: "Otwórz nawigację" }).click();
      const drawerBrand = page.locator('[data-testid="mobile-nav-drawer"] [data-testid="product-brand"]');
      await drawerBrand.waitFor({ state: "visible", timeout: 20_000 });
      const drawerText = await drawerBrand.innerText();
      assert.match(drawerText, /Flip Manager/);
      assert.match(drawerText, /Jakub Okruszek/);
      assert.doesNotMatch(drawerText, /Investment OS/, "the old Investment OS subtitle must not appear in the opened menu's brand mark either");
      assert.doesNotMatch(drawerText, /…|\.\.\./, `the opened menu's brand mark must show the full name, not "${drawerText}"`);

      await assertNotClipped(drawerBrand.locator("text=Flip Manager").first(), "the Flip Manager name in the opened mobile menu");
      await assertNotClipped(drawerBrand.getByLabel("Jakub Okruszek"), "the Jakub Okruszek signature in the opened mobile menu");
      await assertNoPageOverflow(page, `mobile ${viewport.width}px, menu open`);

      const signatureStyle = await drawerBrand.getByLabel("Jakub Okruszek").evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, fontWeight: style.fontWeight, fontFamily: style.fontFamily };
      });
      assert.equal(signatureStyle.color, "rgb(214, 179, 90)", "the signature must render in the gold brand color");
      assert.ok(Number(signatureStyle.fontWeight) >= 700, `the signature must render bold, got font-weight ${signatureStyle.fontWeight}`);
      assert.match(signatureStyle.fontFamily, /cursive|Segoe Print|Bradley Hand|Comic Sans MS/i, "the signature must render in a handwritten-style font");

      await page.close();
    });
  }

  assert.equal(server.exitCode, null, "the Next.js server must still be running after all viewport checks");
});
