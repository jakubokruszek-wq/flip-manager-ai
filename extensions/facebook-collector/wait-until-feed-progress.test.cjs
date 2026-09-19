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

// L. nothing changes -> timeout/stable outcome, no hang
test("L: an unchanging feed resolves to STABLE (or TIMEOUT) — it never hangs past the bound", async () => {
  const { waitUntilFeedProgress } = loadContentModule();
  const started = Date.now();
  const outcome = await waitUntilFeedProgress({
    sample: () => baseSample(),
    timeoutMs: 300,
    pollMs: 10,
    stableChecks: 3,
  });
  const elapsed = Date.now() - started;
  assert.ok(outcome.outcome === "STABLE" || outcome.outcome === "TIMEOUT", `expected a terminal outcome, got ${outcome.outcome}`);
  assert.ok(elapsed <= 400, `must never run meaningfully past the bound, took ${elapsed}ms`);
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
