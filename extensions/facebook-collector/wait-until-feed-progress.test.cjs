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

const baseSample = () => ({ postCount: 5, networkCount: 5, visibleCount: 5, scrollHeight: 1000, cardCount: 5 });

// J. condition waiter receives network progress early -> exits before timeout
test("J: network progress (more responses) exits well before the timeout", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  let calls = 0;
  const outcome = await waitUntilFeedProgress({
    sample: () => { calls += 1; return calls >= 3 ? { ...baseSample(), networkCount: 8 } : baseSample(); },
    timeoutMs: 5_000,
    pollMs: 10,
    stableChecks: 10,
  });
  assert.equal(outcome.outcome, "PROGRESS");
  assert.ok(outcome.waitedMs < 5_000, `expected an early exit, waited ${outcome.waitedMs}ms`);
});

// K. DOM progress early -> exits before timeout
test("K: DOM growth (more cards / taller scroll height) exits well before the timeout", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  let calls = 0;
  const outcome = await waitUntilFeedProgress({
    sample: () => { calls += 1; return calls >= 2 ? { ...baseSample(), cardCount: 9, scrollHeight: 1800 } : baseSample(); },
    timeoutMs: 5_000,
    pollMs: 10,
    stableChecks: 10,
  });
  assert.equal(outcome.outcome, "PROGRESS");
  assert.ok(outcome.waitedMs < 5_000, `expected an early exit, waited ${outcome.waitedMs}ms`);
});

test("an unchanging feed resolves to STABLE well before the timeout bound", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => baseSample(),
    timeoutMs: 5_000,
    pollMs: 10,
    stableChecks: 3,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "STABLE");
  assert.ok(elapsed < 5_000, `must never run meaningfully past the bound, took ${elapsed}ms`);
});

// L. dedicated TIMEOUT outcome test (no "STABLE or TIMEOUT" assertion): a sample that keeps
// changing every poll (so it is never twice-in-a-row identical) without ever exceeding the
// baseline (so it never counts as progress either) must resolve to TIMEOUT, never hang.
test("L: a feed that keeps fluctuating without ever exceeding baseline or repeating twice in a row times out, not hangs", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  let toggle = false;
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => { toggle = !toggle; return { ...baseSample(), cardCount: toggle ? 4 : 3 }; },
    timeoutMs: 150,
    pollMs: 10,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "TIMEOUT");
  assert.ok(outcome.waitedMs >= 150, `TIMEOUT must only fire once the bound is reached, waited ${outcome.waitedMs}ms`);
  assert.ok(elapsed < 400, `must not run meaningfully past the bound, took ${elapsed}ms`);
});

// Stability hardening: STABLE must require ~400ms of unchanged evidence (the new, more
// conservative default), not the old ~200ms — Facebook can still deliver genuinely delayed
// network data in that window.
test("STABLE cannot happen before the new conservative stability window (~400ms with default settings)", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => baseSample(),
    timeoutMs: 5_000,
    pollMs: 100,
    // stableChecks intentionally omitted: exercise the real production default.
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "STABLE");
  assert.ok(elapsed >= 400, `STABLE fired too early (after only ${elapsed}ms) — must wait for at least 4 unchanged polls at the default 100ms cadence`);
});

test("PROGRESS may still return early (~one poll) even under the new conservative stability defaults", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  let calls = 0;
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => { calls += 1; return calls >= 2 ? { ...baseSample(), networkCount: 9 } : baseSample(); },
    timeoutMs: 5_000,
    pollMs: 100,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "PROGRESS");
  assert.ok(elapsed < 400, `progress must not be held back by the stability window, took ${elapsed}ms`);
});

// M. aborted wait -> immediate safe abort
test("M: a pre-aborted signal returns ABORTED immediately without polling", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  const controller = new AbortController();
  controller.abort();
  let sampled = 0;
  const outcome = await waitUntilFeedProgress({
    sample: () => { sampled += 1; return baseSample(); },
    timeoutMs: 5_000,
    pollMs: 10,
    signal: controller.signal,
  });
  assert.equal(outcome.outcome, "ABORTED");
  assert.equal(outcome.waitedMs, 0);
  assert.equal(sampled, 0, "an already-aborted wait must not even take a baseline sample");
});

test("M2: aborting mid-wait stops polling promptly instead of running to the full timeout", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => baseSample(),
    timeoutMs: 5_000,
    pollMs: 10,
    stableChecks: 1_000,
    signal: controller.signal,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.outcome, "ABORTED");
  assert.ok(elapsed < 500, `expected a prompt abort, took ${elapsed}ms`);
});
