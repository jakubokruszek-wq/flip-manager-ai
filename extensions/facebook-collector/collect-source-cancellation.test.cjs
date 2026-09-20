/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * A minimal but real scroll loop for collectSource: an empty main feed (no
 * articles, no scripts, no network records) that never finds anything new,
 * so it runs its natural NO_NEW_POSTS_AND_CARDS_3_SCROLLS stop after a few
 * real (but bounded, STABLE-driven) wait cycles unless cancelled first.
 */
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

function collectSourceMessage(runId, overrides = {}) {
  return { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 30, maxPosts: 50, budgetMs: 20_000, ...overrides } };
}

function sendAndWait(dispatch, message) {
  return new Promise((resolve) => {
    const keepChannelOpen = dispatch(message, {}, resolve);
    if (keepChannelOpen !== true) resolve(undefined);
  });
}

// A. real cancellation message aborts active collectSource
test("A: an explicit CANCEL_SOURCE_COLLECTION message aborts the matching active run", async () => {
  const { dispatch } = loadContentModule();
  const runId = "run-a";
  const started = Date.now();
  const resultPromise = sendAndWait(dispatch, collectSourceMessage(runId));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelResponse = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_CANCEL" });
  assert.equal(cancelResponse.ok, true);
  assert.equal(cancelResponse.aborted, true, "the active run must be found and aborted");
  const result = await resultPromise;
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.result.discoveryStopReason, "ABORTED");
  // Natural completion (no cancel) takes several full STABLE wait cycles —
  // cancelling shortly after start must finish well before that.
  assert.ok(elapsed < 1_000, `cancellation must stop the run promptly, took ${elapsed}ms`);
});

// B. cancel for old run cannot abort newer run
test("B: a stale cancel for a finished/old runId cannot abort a different, currently active run", async () => {
  const { dispatch } = loadContentModule();
  const oldRunResult = await sendAndWait(dispatch, collectSourceMessage("run-old", { minScrolls: 0, maxScrolls: 0 }));
  assert.equal(oldRunResult.ok, true, "the old run must complete (MAX_SCROLLS with maxScrolls: 0) before we try to cancel it");

  const newRunId = "run-new";
  const started = Date.now();
  const newRunPromise = sendAndWait(dispatch, collectSourceMessage(newRunId));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const staleCancel = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId: "run-old", reason: "STALE" });
  assert.equal(staleCancel.aborted, false, "the old run is already gone — nothing to abort");
  const freshCancel = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId: newRunId, reason: "REAL_CANCEL" });
  assert.equal(freshCancel.aborted, true, "the actually-active run can still be cancelled after the stale message");
  const result = await newRunPromise;
  const elapsed = Date.now() - started;
  assert.equal(result.result.discoveryStopReason, "ABORTED");
  assert.ok(elapsed < 1_000, `the new run must have been stopped by its own cancel, took ${elapsed}ms`);
});

// C. controller cleaned after completion
test("C: the controller is cleaned up after completion — a cancel for a finished run finds nothing", async () => {
  const { dispatch } = loadContentModule();
  const runId = "run-finished";
  // scanMode: DEEP_RECALL is never eligible for the adaptive deeper-feed
  // transition, so maxScrolls: 0 really does stop the run immediately at
  // MAX_SCROLLS — a clean, quick completion to test post-completion cleanup.
  const result = await sendAndWait(dispatch, collectSourceMessage(runId, { minScrolls: 0, maxScrolls: 0, scanMode: "DEEP_RECALL" }));
  assert.equal(result.ok, true);
  assert.equal(result.result.discoveryStopReason, "MAX_SCROLLS");
  // The response and the map cleanup are two separate steps of the same
  // .then/.catch/.finally chain — give the .finally() cleanup a tick to run
  // after the response before checking that the map entry is really gone.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelAfterDone = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TOO_LATE" });
  assert.equal(cancelAfterDone.aborted, false, "the run's controller must already be removed from the active map");
});

// D. adaptive deeper + cancellation -> does not consume the extra 45s after abandonment
test("D: cancelling a sparse FAST_REPEAT run — one that would otherwise have gone on to trigger adaptive deeper feed — never lets it consume that extra budget", async () => {
  const { dispatch } = loadContentModule();
  const runId = "run-deeper-cancel";
  const started = Date.now();
  // An empty feed in FAST_REPEAT mode is exactly the sparse case that would
  // trigger DEEPER_NETWORK_FEED (extra +10 scrolls / +45s budget) once
  // CURRENT_DEPTH's own NO_NEW_POSTS stop fires. Cancelling promptly, before
  // that stop is even reached, proves the orchestrator's abandonment signal
  // pre-empts the extra budget entirely rather than letting it be consumed
  // first.
  const resultPromise = sendAndWait(dispatch, collectSourceMessage(runId, { minScrolls: 3, maxScrolls: 30, budgetMs: 20_000 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelResponse = await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "ORCHESTRATOR_ABANDONED" });
  const result = await resultPromise;
  const elapsed = Date.now() - started;
  assert.equal(cancelResponse.aborted, true, "the run must still be active (and found) at cancellation time");
  assert.equal(result.result.discoveryStopReason, "ABORTED");
  assert.ok(elapsed < 1_000, `cancellation must pre-empt any deeper-feed extension entirely, took ${elapsed}ms (the extra allowance alone is 45,000ms)`);
});
