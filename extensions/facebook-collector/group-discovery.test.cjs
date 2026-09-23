/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadModule() {
  delete require.cache[require.resolve("./group-discovery.js")];
  return require(path.join(__dirname, "group-discovery.js"));
}

function fakeRoot(anchors) {
  return {
    querySelectorAll(selector) {
      if (selector !== "a[href]") return [];
      return anchors;
    },
  };
}

function anchor(href, textContent) {
  return { href, textContent };
}

test("a group link with real anchor text is a named candidate", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([anchor("https://www.facebook.com/groups/999888777/", "Łódź Nieruchomości Flip")]);
  const candidates = extractGroupCandidatesFromDom(root);
  assert.deepEqual(candidates, [{ url: "https://www.facebook.com/groups/999888777/", name: "Łódź Nieruchomości Flip" }]);
});

test("a relative href is resolved against facebook.com", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([anchor("/groups/999888777/", "Some Group")]);
  const candidates = extractGroupCandidatesFromDom(root);
  assert.equal(candidates[0].url, "https://www.facebook.com/groups/999888777/");
});

test("mobile Facebook anchors normalize to desktop URLs and prefer an accessible label", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([{
    href: "https://m.facebook.com/groups/MobileGroup/?ref=bookmarks#recent",
    textContent: "technical text",
    getAttribute(name) { return name === "aria-label" ? "Mobile Human Group" : null; },
  }]);
  assert.deepEqual(extractGroupCandidatesFromDom(root), [{ url: "https://www.facebook.com/groups/MobileGroup/", name: "Mobile Human Group" }]);
});

// "No activation from a screenshot name alone": a link with no readable text
// must report name=null, never invent one from the URL/identifier.
test("a link with no visible text (or whose text is just the raw identifier) has name=null", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([
    anchor("https://www.facebook.com/groups/111/", "   "),
    anchor("https://www.facebook.com/groups/222/", "222"),
  ]);
  const candidates = extractGroupCandidatesFromDom(root);
  assert.equal(candidates.find((c) => c.url.includes("111")).name, null);
  assert.equal(candidates.find((c) => c.url.includes("222")).name, null);
});

test("subpaths (posts, members, about) are never treated as group links themselves", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([
    anchor("https://www.facebook.com/groups/999/posts/123/", "A post"),
    anchor("https://www.facebook.com/groups/999/members/", "Members"),
    anchor("https://www.facebook.com/groups/999/about/", "About"),
  ]);
  assert.equal(extractGroupCandidatesFromDom(root).length, 0);
});

test("a non-facebook.com link is ignored even if it happens to contain /groups/", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([anchor("https://example.com/groups/999/", "Fake")]);
  assert.equal(extractGroupCandidatesFromDom(root).length, 0);
});

test("the same group linked twice on the page is only reported once", () => {
  const { extractGroupCandidatesFromDom } = loadModule();
  const root = fakeRoot([
    anchor("https://www.facebook.com/groups/999/", "Group Name"),
    anchor("https://www.facebook.com/groups/999/", "Group Name (again)"),
  ]);
  assert.equal(extractGroupCandidatesFromDom(root).length, 1);
});

test("discovery diagnostics count examined, accepted, rejected, and duplicate anchors", () => {
  const { inspectGroupCandidatesFromDom } = loadModule();
  const result = inspectGroupCandidatesFromDom(fakeRoot([
    anchor("https://www.facebook.com/groups/999/", "Group"),
    anchor("https://m.facebook.com/groups/999/", "Duplicate"),
    anchor("https://www.facebook.com/groups/999/posts/1/", "Post"),
    anchor("https://example.com/groups/100/", "Foreign"),
  ]));
  assert.deepEqual(result.diagnostics, { examined: 4, accepted: 1, rejected: 2, duplicates: 1, loadedOnly: true });
});

test("buildDiscoveryPayload attaches a discoveredAt timestamp to every candidate", () => {
  const { buildDiscoveryPayload } = loadModule();
  const payload = buildDiscoveryPayload([{ url: "https://www.facebook.com/groups/999/", name: "Group" }]);
  assert.equal(payload.length, 1);
  assert.ok(!Number.isNaN(Date.parse(payload[0].discoveredAt)));
  assert.equal(payload[0].url, "https://www.facebook.com/groups/999/");
  assert.equal(payload[0].name, "Group");
});
