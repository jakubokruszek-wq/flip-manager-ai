/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadModule() {
  delete require.cache[require.resolve("./group-discovery.js")];
  // Mirrors a real, separate page's own isolated-world globalThis: each test
  // here simulates a fresh injection into a fresh page, which the
  // globalThis-keyed idempotency guard must not conflate with an earlier
  // test's (unrelated) "page".
  delete globalThis.__flipGroupDiscoveryInjected;
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
  assert.deepEqual(result.diagnostics, { pageUrl: null, examined: 4, accepted: 1, namesFound: 1, rejected: 2, duplicates: 1, loadedOnly: true, reason: null });
});

// "Nie uznawaj samego działania Collectora za dowód działania discovery":
// when discovery genuinely finds nothing, the operator needs a specific,
// actionable reason, not just silence -- distinguishing "the page had no
// /groups/ links at all" (wrong page, or Facebook's markup changed) from
// "every examined anchor was rejected" from a generic empty result.
test("an empty result carries a specific, human-readable reason distinguishing why nothing was found", () => {
  const { inspectGroupCandidatesFromDom } = loadModule();
  const noLinksAtAll = inspectGroupCandidatesFromDom(fakeRoot([]));
  assert.equal(noLinksAtAll.diagnostics.reason, "NO_LINKS_ON_PAGE");

  const onlyRejected = inspectGroupCandidatesFromDom(fakeRoot([anchor("https://example.com/groups/100/", "Foreign")]));
  assert.equal(onlyRejected.diagnostics.reason, "NO_GROUP_LINKS_AMONG_EXAMINED_ANCHORS");

  const found = inspectGroupCandidatesFromDom(fakeRoot([anchor("https://www.facebook.com/groups/999/", "Group")]));
  assert.equal(found.diagnostics.reason, null, "a non-empty result must never carry a 'why empty' reason");
});

test("diagnostics count how many accepted candidates have a real, readable name versus none at all", () => {
  const { inspectGroupCandidatesFromDom } = loadModule();
  const result = inspectGroupCandidatesFromDom(fakeRoot([
    anchor("https://www.facebook.com/groups/111/", "Named Group"),
    anchor("https://www.facebook.com/groups/222/", "   "),
  ]));
  assert.equal(result.diagnostics.accepted, 2);
  assert.equal(result.diagnostics.namesFound, 1, "only the genuinely named candidate must count toward namesFound");
});

test("buildDiscoveryPayload attaches a discoveredAt timestamp to every candidate", () => {
  const { buildDiscoveryPayload } = loadModule();
  const payload = buildDiscoveryPayload([{ url: "https://www.facebook.com/groups/999/", name: "Group" }]);
  assert.equal(payload.length, 1);
  assert.ok(!Number.isNaN(Date.parse(payload[0].discoveredAt)));
  assert.equal(payload[0].url, "https://www.facebook.com/groups/999/");
  assert.equal(payload[0].name, "Group");
});

// Facebook's "Twoje grupy" page lazy-loads groups as the user scrolls -- a
// single immediate DOM read only sees the first rendered batch. This proves
// scrollUntilStable keeps scrolling while new groups keep appearing, and
// stops once the count is unchanged for two consecutive rounds.
test("scrollUntilStable keeps scrolling while new groups keep appearing, and stops once stable", async () => {
  const { scrollUntilStable } = loadModule();
  // Simulates three lazy-loaded batches: 1 group, then 2, then 3 -- stable
  // (3) for the required two consecutive rounds after that.
  const batches = [
    [anchor("https://www.facebook.com/groups/1/", "Group 1")],
    [anchor("https://www.facebook.com/groups/1/", "Group 1"), anchor("https://www.facebook.com/groups/2/", "Group 2")],
    [anchor("https://www.facebook.com/groups/1/", "Group 1"), anchor("https://www.facebook.com/groups/2/", "Group 2"), anchor("https://www.facebook.com/groups/3/", "Group 3")],
  ];
  let scrollCalls = 0;
  const root = { querySelectorAll: (selector) => (selector === "a[href]" ? (batches[Math.min(scrollCalls, batches.length - 1)]) : []) };
  const scrollFn = () => { scrollCalls += 1; };
  const waitFn = () => Promise.resolve();

  const result = await scrollUntilStable(root, { scrollFn, waitFn });
  assert.equal(result.candidates.length, 3, "must have picked up all three lazy-loaded groups");
  assert.equal(result.diagnostics.stabilized, true);
  // Scroll 1 reveals batch 2 (2 groups), scroll 2 reveals batch 3/final (3
  // groups), scrolls 3 and 4 each re-confirm the same count (3) -- two
  // consecutive stable rounds -- before stopping.
  assert.equal(scrollCalls, 4);
});

test("scrollUntilStable gives up after maxAttempts on a page that never stabilizes", async () => {
  const { scrollUntilStable } = loadModule();
  let n = 0;
  // Every scroll reveals exactly one more group forever -- simulates an
  // unrelated infinite feed that must never hang discovery.
  const root = { querySelectorAll: (selector) => (selector === "a[href]" ? Array.from({ length: n }, (_, i) => anchor(`https://www.facebook.com/groups/${i}/`, `Group ${i}`)) : []) };
  const result = await scrollUntilStable(root, { scrollFn: () => { n += 1; }, waitFn: () => Promise.resolve(), maxAttempts: 5 });
  assert.equal(result.diagnostics.scrollAttempts, 5);
  assert.equal(result.diagnostics.stabilized, false);
});

test("a page with no lazy-loaded groups at all (candidate count already stable from the first read) stops after the minimum confirming rounds", async () => {
  const { scrollUntilStable } = loadModule();
  const fixed = [anchor("https://www.facebook.com/groups/1/", "Only Group")];
  let scrollCalls = 0;
  const root = fakeRoot(fixed);
  const result = await scrollUntilStable(root, { scrollFn: () => { scrollCalls += 1; }, waitFn: () => Promise.resolve() });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.stabilized, true);
  assert.equal(scrollCalls, 2, "must still confirm stability with the minimum required rounds before stopping, not stop after a single read");
});

// Facebook is a heavy client-rendered SPA: this content script runs at
// document_idle, which can fire before React has actually painted the group
// list -- an immediate read could see zero links even on the right page
// with intact selectors, purely from a timing race. waitForInitialRender
// exists to poll for the first real content before the scroll loop starts.
test("waitForInitialRender polls until the first group link actually appears, instead of reading an empty pre-render DOM once", async () => {
  const { waitForInitialRender } = loadModule();
  let renderTick = 0;
  const root = { querySelectorAll: (selector) => (selector === "a[href]" && renderTick >= 3 ? [anchor("https://www.facebook.com/groups/1/", "Group")] : []) };
  const result = await waitForInitialRender(root, { waitFn: () => { renderTick += 1; return Promise.resolve(); } });
  assert.equal(result.rendered, true);
  assert.equal(result.attempts, 3);
});

test("waitForInitialRender gives up after maxAttempts on a page that genuinely never renders any group link", async () => {
  const { waitForInitialRender } = loadModule();
  const root = { querySelectorAll: () => [] };
  const result = await waitForInitialRender(root, { waitFn: () => Promise.resolve(), maxAttempts: 5 });
  assert.equal(result.rendered, false);
  assert.equal(result.attempts, 5);
});

// The popup's "Wykryj grupy nieruchomości" button cannot call the scan
// function directly (it lives in the content script's isolated world, not
// the popup) -- it must ask this content script to run it via a message.
test("RUN_GROUP_DISCOVERY message triggers the same scan the automatic page-load run uses, and passes its result straight through", async () => {
  const sentMessages = [];
  let registeredListener = null;
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => { sentMessages.push(message); callback({ ok: true, result: { token: "session-token", expiresAt: "2026-09-26T00:10:00.000Z" } }); },
      onMessage: { addListener: (listener) => { registeredListener = listener; } },
    },
  };
  global.document = { querySelectorAll: () => [{ href: "https://www.facebook.com/groups/999/", textContent: "A group" }] };
  try {
    loadModule();
    assert.ok(registeredListener, "group-discovery.js must register an onMessage listener for on-demand runs");

    const responses = [];
    const handled = registeredListener({ type: "RUN_GROUP_DISCOVERY" }, {}, (response) => responses.push(response));
    assert.equal(handled, true, "the listener must return true to keep the message channel open for its async respond()");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].type, "REPORT_DISCOVERED_GROUPS");
    assert.deepEqual(responses, [{ ok: true, result: { token: "session-token", expiresAt: "2026-09-26T00:10:00.000Z" } }]);

    const unrelated = registeredListener({ type: "SOME_OTHER_MESSAGE" }, {}, () => { throw new Error("must not respond to unrelated messages"); });
    assert.equal(unrelated, undefined, "an unrelated message type must be ignored, not swallowed as a match");
  } finally {
    delete global.chrome;
    delete global.document;
  }
});

// Real risk introduced by popup.js's own injection-retry fix: if the static
// content_scripts entry actually did fire (just slower than the retry's own
// "no response yet" check), the retry's chrome.scripting.executeScript call
// lands a second copy of this exact file in the same page. Proves that
// landing is harmless: injecting it twice into what the guard sees as the
// SAME page (same globalThis, deliberately not reset between the two loads
// below) registers the onMessage listener only once.
test("injecting this file twice into the same page (the static entry, then popup.js's own retry) never double-registers the onMessage listener", () => {
  const registeredListeners = [];
  global.chrome = {
    runtime: {
      sendMessage: (_message, callback) => callback({ ok: true, result: {} }),
      onMessage: { addListener: (listener) => { registeredListeners.push(listener); } },
    },
  };
  global.document = { querySelectorAll: () => [] };
  try {
    delete require.cache[require.resolve("./group-discovery.js")];
    delete globalThis.__flipGroupDiscoveryInjected;
    require(path.join(__dirname, "group-discovery.js"));
    delete require.cache[require.resolve("./group-discovery.js")];
    // Deliberately do NOT delete globalThis.__flipGroupDiscoveryInjected here
    // -- this second require simulates a second injection into the SAME
    // page, which is exactly the scenario the guard must make harmless.
    require(path.join(__dirname, "group-discovery.js"));
    assert.equal(registeredListeners.length, 1, "a second injection into the same page must never register a second onMessage listener");
  } finally {
    delete global.chrome;
    delete global.document;
    delete globalThis.__flipGroupDiscoveryInjected;
  }
});
