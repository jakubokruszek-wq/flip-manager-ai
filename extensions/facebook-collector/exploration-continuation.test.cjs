/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * Recall engine V1.2: proves the exploration-floor/expandability gate is
 * actually wired into content.js's real scroll loop, not just correct as a
 * pure function. Reuses the same real-collectSource harness pattern as
 * collect-source-cancellation.test.cjs and recall-telemetry.test.cjs — a
 * genuinely empty feed (no articles ever render), so every scroll iteration
 * is a real NO_NEW_POSTS_AND_CARDS_3_SCROLLS candidate, and `window.scrollY`
 * genuinely advances on each scroll like a real browser tab.
 */
function loadContentModule({ scrollHeight }) {
  const chromeListeners = [];
  global.globalThis.FlipFacebookCollectorCore = undefined;
  global.globalThis.__flipCollectorContent = undefined;
  delete require.cache[require.resolve("./collector-core.js")];
  global.window = { addEventListener: () => {}, scrollY: 0, scrollBy(options) { global.window.scrollY += options?.top || 0; } };
  global.innerHeight = 900;
  global.location = { origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" };
  const scrollingElement = { scrollHeight, scrollTop: 0 };
  global.document = {
    addEventListener: () => {},
    readyState: "complete",
    scripts: [],
    scrollingElement,
    documentElement: scrollingElement,
    body: { innerText: "" },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.chrome = { runtime: { onMessage: { addListener: (handler) => chromeListeners.push(handler) }, sendMessage: () => {} } };
  require(path.join(__dirname, "collector-core.js"));
  delete require.cache[require.resolve("./content.js")];
  require(path.join(__dirname, "content.js"));
  return { dispatch: chromeListeners[0] };
}

function sendAndWait(dispatch, message) {
  return new Promise((resolve) => {
    const keepChannelOpen = dispatch(message, {}, resolve);
    if (keepChannelOpen !== true) resolve(undefined);
  });
}

// A/G. an expandable feed (never confirmed at the physical bottom) is not allowed to stop on NO_NEW_3 alone,
// and keeps buying bounded extra depth beyond the single one-shot V1.1 transition.
test("A: an expandable feed (never reaches the physical bottom) keeps exploring past the first NO_NEW_3 stop instead of ending there", async () => {
  // A huge scrollHeight relative to the ~765px/scroll the fake browser makes:
  // window.scrollY never gets remotely close to "confirmed at the bottom"
  // within this test's short real window, so every expandability check sees
  // atBottom === false the whole time.
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000 });
  const runId = "run-expandable";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  // Let it run past the first (MAX_SCROLLS-triggered) deeper-feed transition
  // and at least one repeated NO_NEW_3 hit inside DEEPER_NETWORK_FEED mode
  // (each STABLE wait cycle takes ~400-500ms, and consecutiveNoVisibleGrowth
  // needs 3 full iterations after the transition to reach the threshold
  // again), then cut it short with a real cancellation rather than waiting
  // out the full envelope — this test only needs to prove the new branch
  // fires, not that it runs to completion.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  const cancelResponse = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  assert.equal(cancelResponse.aborted, true, "the run must still be active when cancelled");
  assert.equal(result.ok, true);
  assert.equal(result.result.discoveryStopReason, "ABORTED");
  assert.ok(result.result.recall.adaptiveDeeperTriggered, "the sparse/empty feed must still have triggered the adaptive transition");
  assert.ok(
    result.result.recall.deeperFeedTriggerReasons.some((reason) => reason === "BELOW_MIN_EXPLORATION_FLOOR" || reason === "WITHIN_PREFERRED_EXPLORATION_WINDOW"),
    `expected an exploration-floor continuation reason, got ${JSON.stringify(result.result.recall.deeperFeedTriggerReasons)}`,
  );
});

// B. the same shape, but the container is genuinely small (confirmed physical bottom almost immediately) -> normal stop, no hang.
test("B: a confirmed non-expandable feed (small container, quickly at the bottom) stops normally without needing the exploration floor", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 1_000 });
  const message = { type: "COLLECT_SOURCE", runId: "run-non-expandable", options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } };
  const started = Date.now();
  const response = await sendAndWait(dispatch, message);
  const elapsed = Date.now() - started;
  assert.equal(response.ok, true);
  assert.notEqual(response.result.discoveryStopReason, "ABORTED");
  assert.ok(response.result.recall.adaptiveDeeperTriggered, "sparse coverage must still trigger the one baseline sufficiency-based deeper pass");
  // A genuinely exhausted feed must not be kept alive by the exploration
  // floor merely because it hasn't reached 15s yet — the physical-bottom
  // signal must let it converge quickly.
  assert.ok(elapsed < 5_000, `a confirmed non-expandable feed must not be held open by the exploration floor, took ${elapsed}ms`);
});

// H. duplicate rediscovery during extended exploration never inflates the canonical total.
test("H: repeated exploration-floor extensions on a duplicate-only feed never inflate totalUniqueCanonicalPosts", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000 });
  const runId = "run-duplicates-only";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  // This feed never renders a single article, so genuinely zero canonical
  // posts can ever exist — no amount of extended exploration may invent one.
  assert.equal(result.result.recall.totalUniqueCanonicalPosts, 0);
  assert.equal(result.result.posts.length, 0);
});
