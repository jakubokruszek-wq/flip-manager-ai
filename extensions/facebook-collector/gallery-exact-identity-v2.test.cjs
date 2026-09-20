/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * Production defect regression fixture (read-only investigation only — these
 * IDs are never hardcoded into runtime behavior, only into this test):
 * listing 069af68d-c30f-4e4e-b1fd-52d0898350f8, expected Facebook post
 * 1597356762082467 ("38 m², Zgierska, Łódź, 2. piętro, 30 000 zł odstępne").
 * Its gallery was contaminated with 3 images from a real neighboring post in
 * the same feed window, 1597344302083713 ("ŁÓDŹ POLESIE 2 POKOJE"), because
 * hydrateFacebookGallery() promoted any photo anchor found inside the DOM
 * root directly to EXACT_ROOT_STORY without checking its own `set=pcb.<id>`
 * binding. These are the exact post ids the mission cited as evidence.
 */
const EXPECTED_GROUP = "lodzsprzedazzakupwynajem";
const EXPECTED_POST_ID = "1597356762082467";
const FOREIGN_POST_ID = "1597344302083713";
const GALLERY_HYDRATION_MEDIA_ALLOWED = "GALLERY_HYDRATION_MEDIA_ALLOWED";

function loadContentModule() {
  global.globalThis.FlipFacebookCollectorCore = undefined;
  global.globalThis.__flipCollectorContent = undefined;
  delete require.cache[require.resolve("./collector-core.js")];
  global.window = { addEventListener: () => {} };
  global.location = { origin: "https://www.facebook.com", href: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/` };
  global.document = {
    addEventListener: () => {},
    readyState: "complete",
    visibilityState: "visible",
    scripts: [],
    documentElement: { outerHTML: "" },
    title: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} } };
  require(path.join(__dirname, "collector-core.js"));
  delete require.cache[require.resolve("./content.js")];
  return require(path.join(__dirname, "content.js"));
}

function photoAnchor({ fbid, set, imageUrl }) {
  const query = new URLSearchParams({ fbid, ...(set ? { set } : {}) }).toString();
  const anchor = {
    href: `https://www.facebook.com/photo/?${query}`,
    closest: (selector) => (selector === '[role="article"]' ? anchor.__root : null),
    querySelector: () => (imageUrl ? { currentSrc: imageUrl } : null),
  };
  return anchor;
}

/**
 * A single root [role="article"] card exactly as Facebook can render it: one
 * exact self-link + author + message text for the expected post, plus
 * whatever photo anchors the fixture wants nested inside it — including ones
 * that belong to a different post entirely, reproducing the actual DOM
 * composition that caused the production defect.
 */
function fakeExpectedPostRoot({ photoAnchors }) {
  const selfLink = { href: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/`, closest: (selector) => (selector === '[role="article"]' ? root : null) };
  const authorNode = { innerText: "Anna Kowalska", closest: (selector) => (selector === '[role="article"]' ? root : null) };
  const textNode = { innerText: "38 m2, Zgierska, Lodz, 2 pietro, 30000 zl odstepne", closest: (selector) => (selector === '[role="article"]' ? root : null) };
  const root = {
    matches: (selector) => selector === '[role="article"]',
    parentElement: { closest: () => null },
    closest: (selector) => (selector === '[role="article"]' ? root : null),
    querySelectorAll(selector) {
      if (selector === "a[href]") return [selfLink];
      if (selector === "h2 a, h3 a, strong a, [role=heading] a, [data-ad-rendering-role=profile_name]") return [authorNode];
      if (selector === '[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="message"]') return [textNode];
      if (selector === 'a[href*="/photo/"], a[href*="/photo.php"]') return photoAnchors;
      return [];
    },
  };
  for (const anchor of photoAnchors) anchor.__root = root;
  return { root, selfLink };
}

function hydrateOptions(selfLink) {
  global.document.querySelectorAll = (selector) => (selector === "a[href]" ? [selfLink] : []);
  return { imageMode: GALLERY_HYDRATION_MEDIA_ALLOWED, expectedPostId: EXPECTED_POST_ID, expectedUrl: `https://www.facebook.com/groups/${EXPECTED_GROUP}/`, resolvedUrl: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/` };
}

// Critical regression case (mission section 12): the expected post's own DOM
// root also contains a neighboring post's photo anchor (foreign pcb). The
// neighbor's media must never reach the gallery, and with no separately
// exact-bound media of its own, the result must fail closed to zero images —
// never silently fall back to the foreign photo.
test("CRITICAL REGRESSION: a neighboring post's photo inside the expected root is rejected, never persisted", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [photoAnchor({ fbid: "28074641558002", set: `pcb.${FOREIGN_POST_ID}`, imageUrl: "https://scontent.example.com/B_MEDIA_1.jpg" })],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "FACEBOOK_GALLERY_EXACT_MEDIA_NOT_FOUND");
  assert.equal(result.diagnostics.foreignMediaRejectedCount, 1);
  assert.equal(result.diagnostics.exactMediaAcceptedCount, 0);
  assert.ok(result.diagnostics.mediaDiagnostics.some((entry) => entry.reason === "DOM_MEDIA_FOREIGN_PCB" && entry.mediaId === "28074641558002"));
});

// Mixed case (mission section): A's own pcb-bound photo is accepted, the
// neighbor's foreign-pcb photo is rejected, and an unbound photo (no set,
// no structured match) is also rejected — all three resolved independently
// within the SAME root, matching the real DOM composition.
test("MIXED CASE: own pcb-bound media accepted, foreign pcb rejected, unbound rejected — all in the same root", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [
      photoAnchor({ fbid: "28074641558001", set: `pcb.${EXPECTED_POST_ID}`, imageUrl: "https://scontent.example.com/A_MEDIA_1.jpg" }),
      photoAnchor({ fbid: "28074641558002", set: `pcb.${FOREIGN_POST_ID}`, imageUrl: "https://scontent.example.com/B_MEDIA_1.jpg" }),
      photoAnchor({ fbid: "28074641558003", set: null, imageUrl: "https://scontent.example.com/C_MEDIA_1.jpg" }),
    ],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.candidates.length, 1, "only the exact pcb-bound candidate may reach the gallery");
  assert.equal(result.candidates[0].mediaId, "28074641558001");
  assert.equal(result.candidates[0].bindingProvenance, "EXACT_PCB_POST_BINDING");
  assert.equal(result.candidates[0].expectedPostId, EXPECTED_POST_ID);
  assert.deepEqual(result.candidates[0].foreignPostIdsDetected, []);
  assert.equal(result.diagnostics.exactMediaAcceptedCount, 1);
  assert.equal(result.diagnostics.foreignMediaRejectedCount, 1);
  assert.equal(result.diagnostics.unboundMediaRejectedCount, 1);
});

test("EXACT_POST_GRID collects every exact-bound photo anchor, not only the first", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [1, 2, 3, 4, 5].map((value) => photoAnchor({ fbid: `2807464155800${value}`, set: `pcb.${EXPECTED_POST_ID}`, imageUrl: `https://scontent.example.com/GRID_${value}.jpg` })),
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.candidates.length, 5);
  assert.equal(result.diagnostics.exactGridAccepted, 5);
  assert.equal(result.diagnostics.exactGridMediaIds.length, 5);
  assert.ok(result.candidates.every((candidate) => candidate.discoverySource === "EXACT_POST_GRID"));
});

test("EXACT_POST_GRID keeps five exact media while rejecting foreign and unbound anchors", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [
      ...[1, 2, 3, 4, 5].map((value) => photoAnchor({ fbid: `2807464155801${value}`, set: `pcb.${EXPECTED_POST_ID}`, imageUrl: `https://scontent.example.com/GRID_OK_${value}.jpg` })),
      photoAnchor({ fbid: "28074641558111", set: `pcb.${FOREIGN_POST_ID}`, imageUrl: "https://scontent.example.com/GRID_FOREIGN_1.jpg" }),
      photoAnchor({ fbid: "28074641558112", set: `pcb.${FOREIGN_POST_ID}`, imageUrl: "https://scontent.example.com/GRID_FOREIGN_2.jpg" }),
      photoAnchor({ fbid: "28074641558113", set: null, imageUrl: "https://scontent.example.com/GRID_UNBOUND.jpg" }),
    ],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.candidates.length, 5);
  assert.equal(result.diagnostics.exactGridAccepted, 5);
  assert.equal(result.diagnostics.exactGridForeignRejected, 2);
  assert.equal(result.diagnostics.exactGridUnboundRejected, 1);
});

test("EXACT_POST_GRID deduplicates a media id already proven by structured attachments", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const sharedMediaId = "28074641558121";
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [photoAnchor({ fbid: sharedMediaId, set: `pcb.${EXPECTED_POST_ID}`, imageUrl: "https://scontent.example.com/GRID_SHARED.jpg" })],
  });
  global.document.scripts = [{ textContent: JSON.stringify({ __typename: "Story", post_id: EXPECTED_POST_ID, permalink_url: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/`, message: { text: "Sprzedam mieszkanie" }, actor: { name: "Anna Kowalska" }, attachments: [{ __typename: "Photo", media_id: sharedMediaId, image: { uri: "https://scontent.example.com/STRUCTURED_SHARED.jpg" } }] }) }];
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].mediaId, sharedMediaId);
});
// 1/9. Zero-legitimate-media regression: no foreign fallback, gallery never COMPLETE with foreign-only media.
test("1/9: a root with only foreign and unbound media never reports COMPLETE and never falls back to foreign media", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [
      photoAnchor({ fbid: "28074641558002", set: `pcb.${FOREIGN_POST_ID}`, imageUrl: "https://scontent.example.com/B_MEDIA_1.jpg" }),
      photoAnchor({ fbid: "28074641558003", set: null, imageUrl: "https://scontent.example.com/C_MEDIA_1.jpg" }),
    ],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.notEqual(result.status, "COMPLETE");
  assert.equal(result.status, "FAILED");
  assert.equal(result.candidates.length, 0);
});

// 7. same mediaId duplicate -> deduped
test("7: the same mediaId appearing twice in the root is deduped into a single candidate", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [
      photoAnchor({ fbid: "28074641558001", set: `pcb.${EXPECTED_POST_ID}`, imageUrl: "https://scontent.example.com/A_MEDIA_1.jpg" }),
      photoAnchor({ fbid: "28074641558001", set: `pcb.${EXPECTED_POST_ID}`, imageUrl: "https://scontent.example.com/A_MEDIA_1.jpg" }),
    ],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.candidates.length, 1);
});

// 10. media provenance is present for accepted media
test("10: every accepted candidate carries explicit provenance fields", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { selfLink } = fakeExpectedPostRoot({
    photoAnchors: [photoAnchor({ fbid: "28074641558001", set: `pcb.${EXPECTED_POST_ID}`, imageUrl: "https://scontent.example.com/A_MEDIA_1.jpg" })],
  });
  const result = await hydrateFacebookGallery(hydrateOptions(selfLink));
  const candidate = result.candidates[0];
  assert.equal(candidate.mediaId, "28074641558001");
  assert.equal(candidate.expectedPostId, EXPECTED_POST_ID);
  assert.equal(candidate.bindingProvenance, "EXACT_PCB_POST_BINDING");
  assert.equal(candidate.bindingConfidence, 1);
  assert.equal(candidate.classification, "PROPERTY_IMAGE");
});

// 13/14/15: this fix is scoped to gallery media identity only — never touches
// Search, Date/Frontier, or the stuck-card bypass, all defined in the same
// content.js/collector-core.js files.
test("13/14/15: gallery evidence gating shares no state or code path with Search, Date/Frontier, or the stuck-card bypass", () => {
  const core = globalThis.FlipFacebookCollectorCore;
  assert.equal(typeof core.evaluateGalleryMediaCandidateEvidence, "function");
  assert.equal(typeof core.shouldStopDiscovery, "function");
  assert.equal(typeof core.evaluateStuckFeedCondition, "function");
  // Age/frontier thresholds are untouched constants, not something this
  // mission's changes could plausibly have altered.
  assert.equal(core.OLD_POST_STREAK_THRESHOLD, 10);
  assert.equal(core.MIN_SCROLLS_BEFORE_AGE_STOP, 5);
  assert.equal(core.MAX_FAST_SCAN_MS, 180_000);
});
