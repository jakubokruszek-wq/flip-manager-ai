/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { chromium } = require("playwright");

/**
 * Mission: "current" Flip Finder offer cards looked like they had a weaker,
 * gray border than "history"/archive cards. Investigated for real, in a
 * real browser, rather than assumed from source reading: both the active
 * ("AKTYWNE / DOPASOWANE") and archive ("Historia ofert") sections render
 * through the exact same ExpandableListingCard component in
 * inline-filter-results.tsx, with identical props for border purposes --
 * so this test proves whether they are visually identical (as the source
 * suggests) or genuinely diverge once actually rendered and computed by the
 * browser, across the four required viewports.
 */
const activeId = "aaaaaaaa-0000-4000-8000-000000000001";
const sameContentDifferentPostId = "aaaaaaaa-0000-4000-8000-000000000004";
const archivedId = "bbbbbbbb-0000-4000-8000-000000000002";
const reviewId = "cccccccc-0000-4000-8000-000000000003";
const filterId = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-06T12:00:00.000Z";
const operatorSession = {
  access_token: "browser-test-access-token",
  refresh_token: "browser-test-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user: {
    id: "44444444-4444-4444-8444-444444444444",
    email: "operator@example.test",
    app_metadata: { role: "operator" },
    user_metadata: {},
    aud: "authenticated",
    created_at: now,
  },
};

const filter = {
  id: filterId,
  name: "Border investigation filter",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 12_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: now,
  createdAt: now,
  updatedAt: now,
};

function baseResult(overrides) {
  return {
    id: activeId,
    title: "Mieszkanie testowe",
    description: "Opis oferty testowej",
    price: 300_000,
    area: 44,
    rooms: 2,
    floor: "2",
    totalFloors: "4",
    buildingType: "blok",
    ownership: "pełna własność",
    images: [],
    pricePerSqm: 6_818,
    locationText: "Łódź",
    address: null,
    city: "Łódź",
    district: null,
    thumbnailUrl: null,
    // Finder receives authoritative source metadata while the legacy listing column is empty.
    sourcePostUrl: "https://www.facebook.com/groups/example/posts/1234567890/",
    originalUrl: null,
    source: "facebook",
    listingStatus: "active",
    isActive: true,
    firstSeenAt: now,
    lastSeenAt: now,
    firstMatchedAt: now,
    lastMatchedAt: now,
    previousPrice: null,
    currentPrice: 300_000,
    isNew: false,
    hasPriceDrop: false,
    priceDropAmount: null,
    matchReasons: [],
    unknownFields: [],
    decisionBucket: "MATCHED",
    lifecycleStatus: "ACTIVE",
    reviewReason: null,
    missingFields: [],
    manualDecision: null,
    galleryStatus: "NOT_REQUESTED",
    galleryJobId: null,
    galleryTotal: 0,
    galleryPersistedCount: 0,
    galleryError: null,
    ...overrides,
  };
}

const activeResult = baseResult({ id: activeId, title: "Aktualna oferta" });
const sameContentDifferentPost = baseResult({
  id: sameContentDifferentPostId,
  title: "Aktualna oferta",
  sourcePostUrl: "https://www.facebook.com/groups/another-group/posts/9876543210/",
});
const archivedResult = baseResult({
  id: archivedId,
  title: "Archiwalna oferta",
  price: 265_000,
  area: 38.6,
  pricePerSqm: 265_000 / 38.6,
  buildingType: null,
  ownership: null,
  decisionBucket: "REJECTED",
  lifecycleStatus: "REJECTED",
  matchReasons: ["max_price_per_sqm"],
});
// The mission's actual real-world case: a "DO OCENY" (current, pending)
// offer missing only building type/ownership -- rendered through the same
// shared ExpandableListingCard as MATCHED and every Watcher card, wrapped by
// ReviewListingCard only to add the accept/reject decision actions.
const reviewResult = baseResult({
  id: reviewId,
  title: "Oferta do oceny",
  buildingType: null,
  ownership: null,
  decisionBucket: "REVIEW",
  lifecycleStatus: "REVIEW",
  unknownFields: ["buildingType", "ownership"],
  missingFields: ["buildingType", "ownership"],
  reviewReason: "Wymaga ręcznej oceny",
});

const listPayload = {
  filters: [filter],
  latestScan: null,
  summary: { activeFilters: 1, pausedFilters: 0, listingsCount: 4, activeListings: 2, removedListings: 1, newMatches: 0 },
};

function resultsPayload(includeArchived) {
  return {
    filter,
    results: [activeResult, sameContentDifferentPost],
    reviewResults: [reviewResult],
    archivedResults: includeArchived ? [archivedResult] : [],
    counts: { active: 2, review: 1, archived: includeArchived ? 1 : 0 },
    total: 2,
    newMatches: 0,
    lastScan: null,
    sourceScans: [],
  };
}

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
      const request = http.get(url, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500);
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Next server did not become ready within 60 seconds");
}

async function borderInfo(page, testId) {
  return page.evaluate((id) => {
    function hasVisibleBorder(elementStyle) {
      const sides = [elementStyle.borderTopWidth, elementStyle.borderRightWidth, elementStyle.borderBottomWidth, elementStyle.borderLeftWidth];
      const colors = [elementStyle.borderTopColor, elementStyle.borderRightColor, elementStyle.borderBottomColor, elementStyle.borderLeftColor];
      return sides.some((width, index) => {
        const widthPx = Number.parseFloat(width);
        if (!widthPx) return false;
        const color = colors[index];
        return color !== "rgba(0, 0, 0, 0)" && color !== "transparent";
      });
    }
    const card = document.querySelector(`[data-testid="finder-card"][data-listing-id="${id}"]`);
    if (!card) return null;
    const outerStyle = window.getComputedStyle(card);
    const rect = card.getBoundingClientRect();
    // The card's own "whole offer" framing is exactly two candidate
    // elements: this outer wrapper (the intended single gold border) and
    // its inner <article> (ExpandableListingCardContent's own root, whose
    // border must be suppressed so it never doubles the outer one).
    // Decorative borders on badges/buttons/metric boxes further inside are
    // legitimate, separate UI elements, not part of this "one card, one
    // frame" question, so they are deliberately excluded here.
    const innerArticle = card.querySelector("article");
    const innerStyle = innerArticle ? window.getComputedStyle(innerArticle) : null;
    const outerVisible = hasVisibleBorder(outerStyle);
    const innerVisible = innerStyle ? hasVisibleBorder(innerStyle) : false;
    return {
      outerBorderWidth: outerStyle.borderTopWidth,
      outerBorderColor: outerStyle.borderTopColor,
      outerVisible,
      innerVisible,
      visibleBorders: (outerVisible ? 1 : 0) + (innerVisible ? 1 : 0),
      width: rect.width,
    };
  }, testId);
}

async function preparePage(browser, baseUrl) {
  const page = await browser.newPage();
  await page.context().addCookies([{ name: "sb-127-auth-token", value: JSON.stringify(operatorSession), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  await page.route("**/api/flip-finder/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/flip-finder/search-filters") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(listPayload), status: 200 });
    }
    if (url.pathname === `/api/flip-finder/search-filters/${filterId}/results`) {
      const includeArchived = url.searchParams.get("view") === "archive";
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(resultsPayload(includeArchived)), status: 200 });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }), status: 200 });
  });
  await page.goto(`${baseUrl}/flip-finder`, { waitUntil: "domcontentloaded" });
  await page.getByText("Aktualna oferta").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByText("Oferta do oceny").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "Otwórz historię ofert" }).click();
  await page.getByText("Archiwalna oferta").first().waitFor({ state: "visible", timeout: 60_000 });
  return page;
}

test("Flip Finder card border: real browser comparison of a current (active) card and a history (archive) card", { timeout: 300_000 }, async (t) => {
  const port = await freePort();
  const authPort = await freePort();
  const root = path.resolve(__dirname, "../../..");
  const nextBin = require.resolve("next/dist/bin/next");
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
  await new Promise((resolve, reject) => {
    authServer.once("error", reject);
    authServer.listen(authPort, "127.0.0.1", resolve);
  });
  t.after(() => authServer.close());
  const childEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-system-ca`.trim(), NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${authPort}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "browser-test-publishable-key" };
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let buildOutput = "";
    build.stdout.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { buildOutput = `${buildOutput}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed with exit code ${code}; output: ${buildOutput}`))));
  });
  const server = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  server.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  t.after(() => { if (!server.killed) server.kill(); });
  await waitForServer(`http://127.0.0.1:${port}/flip-finder`);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const baseUrl = `http://127.0.0.1:${port}`;

  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ];

  for (const viewport of viewports) {
    await t.test(`at ${viewport.width}px: active, review (DO OCENY) and archived cards, overflow, and clickable buttons`, async () => {
      const page = await preparePage(browser, baseUrl);
      await page.setViewportSize(viewport);
      await page.waitForTimeout(50);

      const active = await borderInfo(page, activeId);
      const sameContentDifferentPostCard = await borderInfo(page, sameContentDifferentPostId);
      const review = await borderInfo(page, reviewId);
      const archived = await borderInfo(page, archivedId);
      assert.ok(active, `active card not found at ${viewport.width}px; server output: ${output}`);
      assert.ok(sameContentDifferentPostCard, `a different Facebook post with identical visible content must remain a separate Finder card at ${viewport.width}px`);
      assert.ok(review, `review (DO OCENY) card not found at ${viewport.width}px; server output: ${output}`);
      assert.ok(archived, `archived card not found at ${viewport.width}px; server output: ${output}`);

      for (const [label, card] of [["active", active], ["review", review], ["archived", archived]]) {
        assert.equal(card.outerBorderWidth, active.outerBorderWidth, `border width must match between the active card and the ${label} card at ${viewport.width}px`);
        assert.equal(card.outerBorderColor, active.outerBorderColor, `border color must match between the active card and the ${label} card at ${viewport.width}px`);
        assert.equal(card.visibleBorders, 1, `exactly one visible border expected on the ${label} card at ${viewport.width}px, found ${card.visibleBorders}`);
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `no horizontal overflow expected at ${viewport.width}px, found ${overflow}px`);

      const openButton = page.getByRole("link", { name: "Otwórz Deal Room" }).first();
      await openButton.waitFor({ state: "visible" });
      const box = await openButton.boundingBox();
      assert.ok(box, "the primary action button must have a real, visible bounding box");
      assert.ok(box.width > 0 && box.height > 0, `the primary action button must be clickable (non-zero size) at ${viewport.width}px`);

      if (viewport.width === 1280) {
        assert.equal(await page.locator(`[data-testid="finder-card"][data-listing-id="${activeId}"]`).count(), 1, "the first post must render exactly once");
        assert.equal(await page.locator(`[data-testid="finder-card"][data-listing-id="${sameContentDifferentPostId}"]`).count(), 1, "the second post must render exactly once");
        const activeCard = page.locator(`[data-testid="finder-card"][data-listing-id="${activeId}"]`);
        const reviewCard = page.locator(`[data-testid="finder-card"][data-listing-id="${reviewId}"]`);
        // The accept/reject decision actions are REVIEW-specific chrome
        // rendered as a sibling of the shared card, not inside it (the same
        // shared ExpandableListingCard renders reviewCard itself) -- so they
        // are reached through its parent wrapper, not reviewCard directly.
        const reviewWrapper = reviewCard.locator("xpath=..");
        const activePreview = activeCard.locator("article > button").first();
        const reviewPreview = reviewCard.locator("article > button").first();
        const dialog = page.getByRole("dialog");
        assert.equal(await activePreview.evaluate((el) => getComputedStyle(el).cursor), "pointer", "hovering the card's clickable region must show the pointer cursor, exactly like Watcher");

        // MATCHED: the whole card and the explicit Analizuj action use the
        // same canonical listing id and open the same detail dialog -- with
        // the exact same full content set Watcher's own card (the identical
        // shared ExpandableListingCardContent component, variant="watcher")
        // would show for this listing: title, location, price, area,
        // price/m², a photo or its placeholder, description, an investment
        // score, the Deal Room button, and every detail tab.
        const pagesBeforeClick = page.context().pages().length;
        await activePreview.click();
        await dialog.waitFor({ state: "visible" });
        assert.equal(page.context().pages().length, pagesBeforeClick, "opening the card's own detail dialog must never itself open a new tab/popup (e.g. to Facebook)");
        assert.equal(page.url(), baseUrl + "/flip-finder", "opening the detail dialog must never navigate the page itself");
        const dialogText = (await dialog.textContent()).replace(/ /g, " ");
        assert.match(dialogText, /Aktualna oferta/, "title");
        assert.match(dialogText, /Łódź/, "location");
        assert.match(dialogText, /300 000/, "price");
        assert.match(dialogText, /44/, "area");
        assert.match(dialogText, /6[\s ]?818/, "price per m²");
        assert.match(dialogText, /Opis oferty testowej/, "description");
        assert.match(dialogText, /Ocena inwestycji/, "investment score");
        assert.ok(await dialog.locator('[aria-label="Brak zweryfikowanego zdjęcia"], img, [alt]').first().isVisible().catch(() => false) || /Brak zweryfikowanego zdjęcia/.test(dialogText), "a photo or its explicit placeholder must render");
        for (const tab of ["Informacje", "Szybki podgląd", "Kalkulator", "Ocena potencjału", "Rynek", "Historia ceny"]) {
          assert.ok(await dialog.getByRole("tab", { name: tab }).isVisible(), `tab "${tab}" must be present`);
        }
        assert.equal(await dialog.getByRole("link", { name: /Deal Room/ }).getAttribute("href"), `/deals/${activeId}`, "Deal Room must carry the real canonical listing id, never a guessed one");

        // The real source link only ever appears inside the opened detail
        // dialog -- never as a bare, always-visible link on the collapsed
        // card face (which would risk an accidental click straight through
        // to Facebook before the operator has even opened the offer).
        const listingLink = dialog.locator('a[href="https://www.facebook.com/groups/example/posts/1234567890/"]').first();
        await listingLink.waitFor({ state: "visible" });
        assert.equal(await listingLink.getAttribute("href"), "https://www.facebook.com/groups/example/posts/1234567890/");
        const popupPromise = page.waitForEvent("popup");
        await listingLink.click();
        const popup = await popupPromise;
        assert.equal(popup.url(), "https://www.facebook.com/groups/example/posts/1234567890/");
        await popup.close();

        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        await activeCard.getByRole("button", { name: "Analizuj", exact: true }).click();
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        // Enter and Space on the card's native button are equivalent to a
        // pointer click; Escape closes the details without any scan request.
        await activePreview.focus();
        await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await activePreview.focus();
        await page.keyboard.press(" ");
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        // REVIEW: must open the exact same full detail dialog as MATCHED and
        // Watcher -- the same component, the same tabs, the same Deal Room
        // link and canonical listing id -- never a separate, simplified
        // panel. This fails immediately if REVIEW ever again renders through
        // anything other than the shared ExpandableListingCard.
        assert.equal(await reviewPreview.evaluate((el) => getComputedStyle(el).cursor), "pointer", "hovering the REVIEW card's clickable region must show the pointer cursor too");
        await reviewPreview.click();
        await dialog.waitFor({ state: "visible" });
        assert.equal(page.context().pages().length, pagesBeforeClick, "opening the REVIEW card's detail dialog must never open a new tab/popup");
        assert.equal(page.url(), baseUrl + "/flip-finder", "opening the REVIEW detail dialog must never navigate the page itself");
        const reviewDialogText = (await dialog.textContent()).replace(/ /g, " ");
        assert.match(reviewDialogText, /Oferta do oceny/, "REVIEW title");
        assert.match(reviewDialogText, /Ocena inwestycji/, "REVIEW investment score, same as MATCHED");
        for (const tab of ["Informacje", "Szybki podgląd", "Kalkulator", "Ocena potencjału", "Rynek", "Historia ceny"]) {
          assert.ok(await dialog.getByRole("tab", { name: tab }).isVisible(), `REVIEW tab "${tab}" must be present, exactly like MATCHED and Watcher`);
        }
        assert.equal(await dialog.getByRole("link", { name: /Deal Room/ }).getAttribute("href"), `/deals/${reviewId}`, "the REVIEW dialog's Deal Room must carry the REVIEW listing's own canonical id");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        await reviewCard.getByRole("button", { name: "Analizuj", exact: true }).click();
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        await reviewPreview.focus();
        await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await reviewPreview.focus();
        await page.keyboard.press(" ");
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });

        // The REVIEW-specific accept/reject decision actions stay, rendered
        // outside the shared card, exactly like Watcher's own workflow
        // actions render outside the same shared card.
        const reviewDecisionRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(`/api/flip-finder/listings/${reviewId}/review`));
        await reviewWrapper.getByRole("button", { name: "DODAJ", exact: true }).click();
        const reviewDecision = await reviewDecisionRequest;
        assert.deepEqual(JSON.parse(reviewDecision.postData() || "{}"), { decision: "ACCEPTED" }, "REVIEW action buttons must keep their existing decision payload");
      }

      const reviewAddButton = page.getByRole("button", { name: "DODAJ" }).first();
      await reviewAddButton.waitFor({ state: "visible" });
      const reviewBox = await reviewAddButton.boundingBox();
      assert.ok(reviewBox && reviewBox.width > 0 && reviewBox.height > 0, `the review card's DODAJ button must be clickable (non-zero size) at ${viewport.width}px`);

      await page.close();
    });
  }
});
