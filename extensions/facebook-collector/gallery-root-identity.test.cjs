/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadContentModule() {
  const listeners = { window: [], chrome: [] };
  global.globalThis.FlipFacebookCollectorCore = {};
  global.globalThis.__flipCollectorContent = undefined;
  global.window = { addEventListener: (type, handler) => listeners.window.push([type, handler]) };
  global.location = { origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" };
  global.document = { addEventListener: () => {}, readyState: "complete", querySelectorAll: () => [] };
  global.chrome = { runtime: { onMessage: { addListener: (handler) => listeners.chrome.push(handler) }, sendMessage: () => {} } };
  delete require.cache[require.resolve("./content.js")];
  const mod = require(path.join(__dirname, "content.js"));
  return mod;
}

const EXPECTED_GROUP = "lodzsprzedazzakupwynajem";
const EXPECTED_POST_ID = "1596571438827666";
const FOREIGN_POST_ID = "9999999999999";

function fakeRoot(links) {
  return {
    querySelectorAll(selector) {
      if (selector !== "a[href]") return [];
      return links.map((href) => ({ href }));
    },
  };
}

function exactLink(postId) {
  return `https://www.facebook.com/groups/${EXPECTED_GROUP}/posts/${postId}/`;
}

test("A/production regression: a root whose only self-link matches the exact canonical post is selected", () => {
  const { galleryRootHasExactPostBinding } = loadContentModule();
  const root = fakeRoot([exactLink(EXPECTED_POST_ID)]);
  assert.equal(galleryRootHasExactPostBinding(root, EXPECTED_GROUP, EXPECTED_POST_ID), true);
});

test("B. a root whose self-link points to a foreign neighbouring post is never selected", () => {
  const { galleryRootHasExactPostBinding } = loadContentModule();
  const foreignRoot = fakeRoot([exactLink(FOREIGN_POST_ID)]);
  assert.equal(galleryRootHasExactPostBinding(foreignRoot, EXPECTED_GROUP, EXPECTED_POST_ID), false);
});

test("C. a root with no self-link at all, or links to more than one distinct post, remains fail-closed", () => {
  const { galleryRootHasExactPostBinding } = loadContentModule();
  assert.equal(galleryRootHasExactPostBinding(fakeRoot([]), EXPECTED_GROUP, EXPECTED_POST_ID), false, "no self-link is not proof");
  assert.equal(galleryRootHasExactPostBinding(fakeRoot([exactLink(EXPECTED_POST_ID), exactLink(FOREIGN_POST_ID)]), EXPECTED_GROUP, EXPECTED_POST_ID), false, "an ambiguous root linking to two distinct posts is never proof of either");
});

test("a self-link into a different group never satisfies the same-canonical-post proof", () => {
  const { galleryRootHasExactPostBinding } = loadContentModule();
  const otherGroupRoot = fakeRoot([`https://www.facebook.com/groups/some-other-group/posts/${EXPECTED_POST_ID}/`]);
  assert.equal(galleryRootHasExactPostBinding(otherGroupRoot, EXPECTED_GROUP, EXPECTED_POST_ID), false);
});

test("production regression case: rootCount=2 (one exact, one foreign) resolves to exactly the exact-bound root, not ambiguous", () => {
  const { galleryRootHasExactPostBinding } = loadContentModule();
  const candidates = [fakeRoot([exactLink(FOREIGN_POST_ID)]), fakeRoot([exactLink(EXPECTED_POST_ID)])];
  const provenRoots = candidates.filter((candidate) => galleryRootHasExactPostBinding(candidate, EXPECTED_GROUP, EXPECTED_POST_ID));
  assert.equal(provenRoots.length, 1, "exactly one of the two candidates proves binding to the expected post — no ambiguity");
});
