/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

/**
 * Stuck-feed / oversized-media bypass (V1.2.1): drives the REAL collectSource
 * loop, exactly like collect-source-cancellation.test.cjs and
 * exploration-continuation.test.cjs, but with a scripted large-video element
 * whose viewport-relative geometry is computed from the CURRENT window.scrollY
 * on every call (matching how getBoundingClientRect behaves on a real,
 * scrolling page). `videoPageBottom` controls how far the collector must
 * scroll before the video stops dominating the viewport — a small value lets
 * one recovery clear it and reveal new content; `Infinity` means it never
 * clears within the test's bounded window, for tests that only need to prove
 * the bypass mechanism itself (repeated triggering, cooldown, the recovery
 * cap) rather than genuine post capture.
 */
function loadContentModule({ scrollHeight, videoPageBottom = Infinity, articlesRevealAtScrollY = null, articleRevealDelayMs = 0 }) {
  const chromeListeners = [];
  global.globalThis.FlipFacebookCollectorCore = undefined;
  global.globalThis.__flipCollectorContent = undefined;
  delete require.cache[require.resolve("./collector-core.js")];
  global.window = { addEventListener: () => {}, scrollY: 0, scrollBy(options) { global.window.scrollY += options?.top || 0; } };
  global.innerHeight = 900;
  global.location = { origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/" };
  const scrollingElement = { scrollHeight, scrollTop: 0 };
  const fakeVideo = {
    tagName: "VIDEO",
    getBoundingClientRect: () => ({ top: 0 - global.window.scrollY, bottom: videoPageBottom - global.window.scrollY, width: 800, height: videoPageBottom }),
  };
  const fakeAnchor = { href: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/9988776655443/" };
  const fakeArticleCard = {
    tagName: "DIV",
    parentElement: { closest: () => null },
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 300, width: 600, height: 300, left: 0, right: 600 }),
    querySelectorAll(selector) { return selector === "a[href]" ? [fakeAnchor] : []; },
    querySelector(selector) { return /href/.test(selector) ? fakeAnchor : null; },
  };
  // Scrolling past the reveal point is not enough by itself in a real browser
  // — Facebook still needs a moment to fetch/render the newly-scrolled-into
  // content. `articleRevealDelayMs` models that: the card only becomes
  // queryable a short, realistic delay after scrollY first crosses the
  // threshold, so a recovery's own condition-wait can genuinely observe it
  // appearing mid-poll rather than it always being "already there".
  let revealedAtRealTime = null;
  global.document = {
    addEventListener: () => {},
    readyState: "complete",
    scripts: [],
    scrollingElement,
    documentElement: scrollingElement,
    body: { innerText: "" },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'video, [role="video"], iframe') return global.window.scrollY < videoPageBottom ? [fakeVideo] : [];
      if (selector === '[role="article"]') {
        if (articlesRevealAtScrollY === null) return [];
        if (global.window.scrollY < articlesRevealAtScrollY) return [];
        if (revealedAtRealTime === null) revealedAtRealTime = Date.now();
        return Date.now() - revealedAtRealTime >= articleRevealDelayMs ? [fakeArticleCard] : [];
      }
      return [];
    },
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

// Regression scenario (mission section 12): an active, expandable feed gets
// visually pinned by a large video for several iterations. Recovery must
// trigger instead of ending the scan at the first NO_NEW_POSTS_AND_CARDS_3_SCROLLS.
test("regression: a dominant video on an expandable feed triggers recovery instead of ending the scan immediately", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 1_000_000 });
  const runId = "run-stuck-regression";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.ok(result.result.recall.stuckRecovery.count >= 1, "the stuck bypass must have triggered at least once");
  assert.equal(result.result.recall.stuckRecovery.events[0].mediaDetected, true);
  assert.equal(result.result.recall.stuckRecovery.events[0].mediaKind, "VIDEO");
  assert.ok(result.result.recall.stuckRecovery.events[0].scrollDelta > 0, "the recovery scroll must actually move the container forward");
});

// True-bottom safety: the same dominant video, but the feed genuinely has no
// more room (small scrollHeight, confirmed physical bottom reached quickly).
// Recovery must never trigger regardless of the video.
test("true-bottom safety: a confirmed non-expandable feed never triggers recovery even with a dominant video present", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 1_000, videoPageBottom: 1_000_000 });
  const message = { type: "COLLECT_SOURCE", runId: "run-stuck-bottom", options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } };
  const started = Date.now();
  const response = await sendAndWait(dispatch, message);
  const elapsed = Date.now() - started;
  assert.equal(response.ok, true);
  assert.equal(response.result.recall.stuckRecovery.count, 0, "a confirmed non-expandable feed must never trigger the bypass");
  assert.ok(elapsed < 5_000, `a genuinely exhausted feed must still converge quickly, took ${elapsed}ms`);
});

// M: MAX_STUCK_RECOVERIES prevents an endless bypass loop even when the video
// never clears within the bounded test window.
test("M: recovery attempts never exceed MAX_STUCK_RECOVERIES even when the video never clears", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 1_000_000 });
  const runId = "run-stuck-cap";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  assert.ok(result.result.recall.stuckRecovery.count <= 3, `must never exceed MAX_STUCK_RECOVERIES(3), got ${result.result.recall.stuckRecovery.count}`);
  assert.ok(result.result.recall.stuckRecovery.events.length <= 3);
});

// I/J/K/L: after recovery, records/ageStreak/scan timing stay intact — this
// is a continuation of the SAME scan, not a reset of it.
test("I/J/K: after a stuck recovery, ageStreak and duration accounting remain a single continuous scan (never reset)", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 1_000_000 });
  const runId = "run-stuck-state";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  assert.ok(result.result.recall.stuckRecovery.count >= 1, "precondition: recovery must have actually happened for this test to be meaningful");
  assert.equal(result.result.ageStreak.consecutiveOldPosts, 0, "an empty feed never invents an age streak");
  assert.equal(result.result.posts.length, 0, "no canonical posts existed in this scenario, so none may appear");
  // currentDepthDurationMs + deeperFeedDurationMs (when present) must still
  // sum to totalDurationMs exactly — the same identity V1.2 already proves —
  // showing recovery time is folded into one continuous clock, not a reset one.
  const recall = result.result.recall;
  assert.equal(recall.currentDepthDurationMs + recall.deeperFeedDurationMs, recall.totalDurationMs);
});

// O: a genuine new canonical post appearing right after recovery is marked RECOVERY_PROGRESS.
test("O: a new canonical post appearing after the recovery scroll is captured and marked RECOVERY_PROGRESS", async () => {
  // Three normal 765px scroll steps (iterations 0-2) land at scrollY=2295,
  // where NO_NEW_POSTS_AND_CARDS_3_SCROLLS first fires — the video (page
  // range [0, 3000]) is still comfortably dominant there (ratio ~0.78), so
  // normal scrolling alone never clears it. The stronger 1125px recovery
  // scroll pushes scrollY to 3420, clearing the video and crossing the
  // article reveal threshold (3300) — modelled with a short realistic delay
  // so the recovery's own condition-wait genuinely observes it appearing
  // mid-poll rather than it already being present at the first sample.
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 3_000, articlesRevealAtScrollY: 3_300, articleRevealDelayMs: 150 });
  const runId = "run-stuck-progress";
  // The post is captured within the first handful of iterations; bound the
  // test with a cancellation rather than waiting out the rest of the
  // envelope (the still-sparse 1-post coverage would otherwise keep the
  // adaptive mechanisms exploring for tens of real seconds).
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 30, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const response = await resultPromise;
  assert.equal(response.ok, true);
  const { recall, posts } = response.result;
  assert.ok(recall.stuckRecovery.count >= 1, "the video must have triggered at least one recovery before the card could appear");
  assert.equal(recall.stuckRecovery.successful, recall.stuckRecovery.events.filter((event) => event.outcome === "RECOVERY_PROGRESS").length);
  assert.ok(recall.stuckRecovery.events.some((event) => event.outcome === "RECOVERY_PROGRESS"), "at least one recovery must be marked as having produced progress");
  assert.ok(posts.length >= 1, "the real post revealed after clearing the video must be captured normally");
  assert.equal(posts[0].postId, "9988776655443");
});

// P: when nothing ever appears, recovery is honestly marked RECOVERY_NO_PROGRESS.
test("P: a recovery that produces nothing new is marked RECOVERY_NO_PROGRESS", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 1_000_000 });
  const runId = "run-stuck-no-progress";
  const resultPromise = sendAndWait(dispatch, { type: "COLLECT_SOURCE", runId, options: { minScrolls: 3, maxScrolls: 0, maxPosts: 50, budgetMs: 20_000 } });
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  await sendAndWait(dispatch, { type: "CANCEL_SOURCE_COLLECTION", runId, reason: "TEST_BOUND" });
  const result = await resultPromise;
  assert.ok(result.result.recall.stuckRecovery.events.length >= 1);
  for (const event of result.result.recall.stuckRecovery.events) assert.equal(event.outcome, "RECOVERY_NO_PROGRESS");
  assert.equal(result.result.recall.stuckRecovery.successful, 0);
});

// Q: SEARCH mode is completely untouched by the stuck-recovery mechanism —
// recall (and therefore stuckRecovery) is null for a search-mode pass, exactly as before V1.2.1.
test("Q: SEARCH mode never engages the stuck-recovery mechanism (recall stays null, exactly as before)", async () => {
  const { dispatch } = loadContentModule({ scrollHeight: 10_000_000, videoPageBottom: 1_000_000 });
  const message = { type: "COLLECT_SOURCE", runId: "run-stuck-search", options: { minScrolls: 0, maxScrolls: 0, maxPosts: 10, budgetMs: 5_000, searchMode: true, searchQuery: "sprzedam" } };
  const response = await sendAndWait(dispatch, message);
  assert.equal(response.ok, true);
  assert.equal(response.result.recall, null, "search-mode passes never report recall telemetry, including stuckRecovery");
});
