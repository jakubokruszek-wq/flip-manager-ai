/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function loadContentModule() {
  const chromeListeners = [];
  global.globalThis.FlipFacebookCollectorCore = undefined;
  global.globalThis.__flipCollectorContent = undefined;
  delete require.cache[require.resolve("./collector-core.js")];
  global.window = { addEventListener: () => {}, scrollY: 0, scrollBy: () => {} };
  global.innerHeight = 900;
  global.location = { origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" };
  const scrollingElement = { scrollHeight: 1000, scrollTop: 0 };
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

test("telemetry: a sparse scan that genuinely reaches DEEPER_NETWORK_FEED reports internally consistent recall telemetry", { timeout: 20_000 }, async () => {
  const { dispatch } = loadContentModule();
  const message = { type: "COLLECT_SOURCE", runId: "run-telemetry", options: { minScrolls: 3, maxScrolls: 3, maxPosts: 50, budgetMs: 20_000, feedDepthMode: "CURRENT_DEPTH" } };
  const response = await sendAndWait(dispatch, message);
  assert.equal(response.ok, true);
  const { recall } = response.result;
  assert.ok(recall, "an empty/sparse FAST_REPEAT scan must report recall telemetry");
  assert.equal(recall.adaptiveDeeperTriggered, true, "an empty feed is sparse and must trigger the adaptive transition");
  assert.equal(recall.initialFeedDepthMode, "CURRENT_DEPTH", "echoed straight from the static feedDepthMode option");
  assert.equal(recall.effectiveFeedDepthMode, "DEEPER_NETWORK_FEED", "adaptive trigger alone must be enough to report the effective mode as widened");
  assert.ok(recall.currentDepth, "the CURRENT_DEPTH snapshot must be captured");
  assert.ok(recall.deeperFeed, "the DEEPER_NETWORK_FEED phase telemetry must be present");
  // The required relation: currentDepthDurationMs + deeperFeedDurationMs == totalDurationMs, exactly.
  assert.equal(recall.currentDepthDurationMs + recall.deeperFeedDurationMs, recall.totalDurationMs);
  // Every deeperFeed field must be this PHASE's own delta, not a repeat of the cumulative total.
  assert.equal(recall.deeperFeed.freshPosts, 0);
  assert.equal(recall.deeperFeed.oldPosts, 0);
  assert.equal(recall.deeperFeed.unknownAgePosts, 0);
  assert.ok(!("uniqueCanonicalPosts" in recall.deeperFeed), "a running total has no place inside a phase-delta object — it lives once, at recall.totalUniqueCanonicalPosts");
  assert.equal(recall.totalUniqueCanonicalPosts, 0, "an empty feed never invents posts");
});

test("telemetry: initialFeedDepthMode reflects the static flag even when the adaptive mechanism never triggers", async () => {
  const { dispatch } = loadContentModule();
  // scanMode DEEP_RECALL is never eligible for the adaptive transition, so this
  // isolates the STATIC dimension: a static DEEPER_NETWORK_FEED flag alone
  // must be visible in effectiveFeedDepthMode without the adaptive mechanism
  // ever firing.
  const message = { type: "COLLECT_SOURCE", runId: "run-static-only", options: { minScrolls: 0, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000, scanMode: "DEEP_RECALL", feedDepthMode: "DEEPER_NETWORK_FEED" } };
  const response = await sendAndWait(dispatch, message);
  assert.equal(response.ok, true);
  const { recall } = response.result;
  assert.equal(recall.initialFeedDepthMode, "DEEPER_NETWORK_FEED");
  assert.equal(recall.adaptiveDeeperTriggered, false, "DEEP_RECALL is never eligible for the adaptive mechanism");
  assert.equal(recall.effectiveFeedDepthMode, "DEEPER_NETWORK_FEED", "the static flag alone must already widen the effective mode");
  assert.equal(recall.deeperFeed, null, "no adaptive phase telemetry exists when the adaptive mechanism never ran");
});
