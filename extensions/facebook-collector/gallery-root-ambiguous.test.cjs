/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * Watcher data quality mission — confirmed real production example:
 * listing 03306c1f-c18b-40dc-b7ab-d61102ced836, Facebook post
 * https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/1598443975307079.
 * The post has a real multi-photo collage on Facebook, but its gallery job
 * failed with FACEBOOK_GALLERY_ROOT_AMBIGUOUS (confirmed via a read-only
 * production query: gallery_status=FAILED, images=[], mediaProvenance=[]) —
 * root disambiguation itself failed, before photo extraction was ever
 * reached. Multi-photo/collage extraction from a SINGLE resolved root is
 * already proven correct elsewhere (gallery-exact-identity-v2.test.cjs's
 * "EXACT_POST_GRID collects every exact-bound photo anchor" case, 5 photos).
 *
 * Reproducing the exact live Facebook DOM structure that produces two
 * differently-signed root candidates for the same post requires an
 * authenticated Facebook session this environment does not have — see the
 * mission report for that disclosed limitation. This fixture instead proves
 * two things that ARE verifiable locally without one: (1) the current
 * fail-closed behavior for a genuine two-different-signature ambiguity is
 * intentional and stays intentional, and (2) the new competingRootSignatures
 * diagnostic (added so a real future occurrence can be diagnosed without a
 * live session at all) is actually populated and correctly shaped.
 */
const EXPECTED_GROUP = "lodzsprzedazzakupwynajem";
const EXPECTED_POST_ID = "1598443975307079";
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
    title: "Grupa Facebook",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} } };
  require(path.join(__dirname, "collector-core.js"));
  delete require.cache[require.resolve("./content.js")];
  return require(path.join(__dirname, "content.js"));
}

/** One [role="article"] candidate with its own self-link, author, message text and photo anchors — everything hydrateFacebookGallery reads to build a root signature. */
function fakeRoot({ authorName, messageText, photoCount }) {
  const selfLink = { href: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/`, closest: (selector) => (selector === '[role="article"]' ? root : null) };
  const authorNode = authorName ? { innerText: authorName, closest: (selector) => (selector === '[role="article"]' ? root : null) } : null;
  const textNode = messageText ? { innerText: messageText, closest: (selector) => (selector === '[role="article"]' ? root : null) } : null;
  const photoAnchors = Array.from({ length: photoCount }, (_, index) => ({
    href: `https://www.facebook.com/photo/?fbid=${28000000000000 + index}&set=pcb.${EXPECTED_POST_ID}`,
    closest: (selector) => (selector === '[role="article"]' ? root : null),
    querySelector: () => ({ currentSrc: `https://scontent.example.com/COLLAGE_${index}.jpg` }),
  }));
  const root = {
    matches: (selector) => selector === '[role="article"]',
    parentElement: { closest: () => null },
    closest: (selector) => (selector === '[role="article"]' ? root : null),
    querySelectorAll(selector) {
      if (selector === "a[href]") return [selfLink];
      if (selector === "h2 a, h3 a, strong a, [role=heading] a, [data-ad-rendering-role=profile_name]") return authorNode ? [authorNode] : [];
      if (selector === '[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="message"]') return textNode ? [textNode] : [];
      if (selector === 'a[href*="/photo/"], a[href*="/photo.php"]') return photoAnchors;
      return [];
    },
  };
  return { root, selfLink };
}

function hydrateOptions(selfLinks) {
  global.document.querySelectorAll = (selector) => (selector === "a[href]" ? selfLinks : []);
  return { imageMode: GALLERY_HYDRATION_MEDIA_ALLOWED, expectedPostId: EXPECTED_POST_ID, expectedUrl: `https://www.facebook.com/groups/${EXPECTED_GROUP}/`, resolvedUrl: `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${EXPECTED_POST_ID}/` };
}

test("REGRESSION (production listing 03306c1f, post 1598443975307079 pattern): two DOM candidates with genuinely different signatures both bind to the exact post -> fail-closed ROOT_AMBIGUOUS, never a guess", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const { root: rootA, selfLink: selfLinkA } = fakeRoot({ authorName: "Anna Kowalska", messageText: "Sprzedam mieszkanie 3 pokoje, 52,70 m2, kolaz zdjec", photoCount: 5 });
  const { root: rootB, selfLink: selfLinkB } = fakeRoot({ authorName: "Jan Nowak", messageText: "Zainteresowany, prosze o kontakt w sprawie oferty", photoCount: 0 });
  global.document.title = "Something else entirely";
  const result = await hydrateFacebookGallery(hydrateOptions([selfLinkA, selfLinkB]));

  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "FACEBOOK_GALLERY_ROOT_AMBIGUOUS");
  assert.equal(result.diagnostics.rootCount, 2);
  assert.ok(rootA && rootB, "both fixture roots must exist and be distinguishable by signature");
});

test("the ROOT_AMBIGUOUS diagnostic records a short, bounded signature per competing candidate — never the raw full post text", async () => {
  const { hydrateFacebookGallery } = loadContentModule();
  const longMessage = "A".repeat(500);
  const { selfLink: selfLinkA } = fakeRoot({ authorName: "Anna Kowalska", messageText: longMessage, photoCount: 5 });
  const { selfLink: selfLinkB } = fakeRoot({ authorName: "Jan Nowak", messageText: "Inna zupelnie tresc", photoCount: 0 });
  global.document.title = "Something else entirely";
  const result = await hydrateFacebookGallery(hydrateOptions([selfLinkA, selfLinkB]));

  assert.equal(result.error, "FACEBOOK_GALLERY_ROOT_AMBIGUOUS");
  const signatures = result.diagnostics.competingRootSignatures;
  assert.equal(signatures.length, 2, "one signature per competing root, so a human can tell them apart without a live session");
  assert.ok(signatures.every((entry) => entry.authorPresent === true));
  assert.ok(signatures.some((entry) => entry.photoAnchorCount === 5), "the collage-bearing candidate's own photo count must be visible in the diagnostic");
  assert.ok(signatures.some((entry) => entry.photoAnchorCount === 0));
  assert.ok(signatures.every((entry) => (entry.rootTextPreview?.length ?? 0) <= 60), "the preview must be short — never the full post message");
});
