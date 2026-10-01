/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "group-discovery-bridge.js"), "utf8");

/**
 * Runtime proof for the exact protocol watched-groups-page.tsx drives
 * (features/facebook-groups/components/watched-groups-page.test.cjs already
 * proves the page's own side via source matching). This actually EXECUTES
 * group-discovery-bridge.js in a real V8 context with fake window/chrome
 * globals -- the same vm.runInContext pattern already established for
 * bootstrap.js in background.test.cjs -- to prove the handshake, a
 * successful round trip, a chrome.runtime protocol error, and origin
 * rejection all genuinely behave as documented, not just that the source
 * text contains the right-looking strings.
 */
function buildContext({ sendMessage, onMessageListeners = [] } = {}) {
  const windowListeners = [];
  const posted = [];
  const window = {
    addEventListener(type, listener) { if (type === "message") windowListeners.push(listener); },
    removeEventListener(type, listener) { if (type === "message") { const index = windowListeners.indexOf(listener); if (index >= 0) windowListeners.splice(index, 1); } },
    postMessage(message, origin) { posted.push({ message, origin }); },
    location: { origin: "http://localhost:3000" },
  };
  const runtime = {
    lastError: null,
    onMessage: { addListener(listener) { onMessageListeners.push(listener); } },
    sendMessage: sendMessage ?? (() => { throw new Error("sendMessage not configured for this test"); }),
  };
  const context = vm.createContext({ window, chrome: { runtime }, console: { debug() {}, warn() {} } });
  vm.runInContext(source, context);
  return { window, windowListeners, posted, runtime };
}

function dispatchFromPage(windowListeners, window, data, origin = window.location.origin) {
  for (const listener of windowListeners) listener({ source: window, origin, data });
}

test("a handshake is acknowledged immediately, before the extension runtime call resolves", () => {
  let capturedCallback = null;
  const { window, windowListeners, posted } = buildContext({
    sendMessage(_message, callback) { capturedCallback = callback; },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  assert.equal(posted.length, 1, "the ACK must be posted synchronously, before background.js ever responds");
  assert.equal(posted[0].message.type, "FLIP_GROUP_DISCOVERY_ACK");
  assert.equal(posted[0].origin, window.location.origin);
  assert.equal(typeof capturedCallback, "function", "the extension runtime call must actually have been made");
});

test("a successful discovery round trip delivers the real token/expiresAt/diagnostics to the page", () => {
  const { window, windowListeners, posted } = buildContext({
    sendMessage(_message, callback) {
      callback({ ok: true, token: "real-token-123", expiresAt: "2026-10-01T00:00:00.000Z", diagnostics: { pageUrl: "https://www.facebook.com/groups/", examined: 12, accepted: 3, namesFound: 3, rejected: 9, duplicates: 0, reason: null } });
    },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  assert.equal(posted.length, 2, "ACK, then the result");
  const result = posted[1].message;
  assert.equal(result.type, "FLIP_GROUP_DISCOVERY_RESULT");
  assert.equal(result.ok, true);
  assert.equal(result.token, "real-token-123");
  assert.equal(result.expiresAt, "2026-10-01T00:00:00.000Z");
  assert.equal(result.diagnostics.accepted, 3);
});

test("a chrome.runtime protocol error (extension context invalidated) reaches the page as a specific, named error", () => {
  const { window, windowListeners, posted, runtime } = buildContext({
    sendMessage(_message, callback) {
      runtime.lastError = { message: "Extension context invalidated." };
      callback(undefined);
    },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  const result = posted[1].message;
  assert.equal(result.type, "FLIP_GROUP_DISCOVERY_RESULT");
  assert.equal(result.ok, false);
  assert.equal(result.error, "EXTENSION_CONTEXT_INVALIDATED", "a known runtime failure must be normalized to its specific code, not a raw error string");
});

test("background.js reporting a failed discovery (e.g. GROUP_DISCOVERY_ORIGIN_REJECTED) is relayed through, not swallowed as a success", () => {
  const { window, windowListeners, posted } = buildContext({
    sendMessage(_message, callback) { callback({ ok: false, error: "GROUP_DISCOVERY_ORIGIN_REJECTED" }); },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  const result = posted[1].message;
  assert.equal(result.ok, false);
  assert.equal(result.error, "GROUP_DISCOVERY_ORIGIN_REJECTED");
});

test("a request from any origin other than the two allowed ones is silently ignored, never acknowledged", () => {
  let called = false;
  const { window, windowListeners, posted } = buildContext({ sendMessage() { called = true; } });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" }, "https://evil.example.com");
  assert.equal(posted.length, 0, "no ACK, no result -- a spoofed origin must get total silence, not even an error");
  assert.equal(called, false, "the extension runtime must never even be contacted for a disallowed origin");
});

test("a message from a different window object (not the page's own window) is ignored, matching the page's own origin+source double check", () => {
  const { window, windowListeners, posted } = buildContext({ sendMessage() {} });
  for (const listener of windowListeners) listener({ source: { fake: true }, origin: window.location.origin, data: { type: "FLIP_GROUP_DISCOVERY_REQUEST" } });
  assert.equal(posted.length, 0);
});

test("an unrelated message type is ignored without posting anything", () => {
  const { window, windowListeners, posted } = buildContext({ sendMessage() {} });
  dispatchFromPage(windowListeners, window, { type: "SOME_OTHER_MESSAGE" });
  assert.equal(posted.length, 0);
});

test("progress pushed from background.js (OPENING_FACEBOOK, then READING) is relayed to the page live, before the final result", () => {
  const onMessageListeners = [];
  let finalCallback = null;
  const { window, windowListeners, posted } = buildContext({
    onMessageListeners,
    sendMessage(_message, callback) { finalCallback = callback; },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  assert.equal(onMessageListeners.length, 1, "the bridge must register exactly one onMessage listener for progress pushes");
  onMessageListeners[0]({ type: "GROUP_DISCOVERY_PROGRESS", stage: "OPENING_FACEBOOK" });
  onMessageListeners[0]({ type: "GROUP_DISCOVERY_PROGRESS", stage: "READING" });
  assert.equal(posted[1].message.type, "FLIP_GROUP_DISCOVERY_PROGRESS");
  assert.equal(posted[1].message.stage, "OPENING_FACEBOOK");
  assert.equal(posted[2].message.type, "FLIP_GROUP_DISCOVERY_PROGRESS");
  assert.equal(posted[2].message.stage, "READING");
  finalCallback({ ok: true, token: "t", expiresAt: "2026-10-01T00:00:00.000Z" });
  assert.equal(posted[3].message.type, "FLIP_GROUP_DISCOVERY_RESULT", "progress must arrive strictly before the final result");
});

test("an unrelated onMessage type (not GROUP_DISCOVERY_PROGRESS) is ignored, never misrouted to the page as progress", () => {
  const onMessageListeners = [];
  const { posted } = buildContext({ onMessageListeners, sendMessage() {} });
  onMessageListeners[0]({ type: "SOME_UNRELATED_BACKGROUND_MESSAGE" });
  assert.equal(posted.length, 0);
});

test("a second, independent request after an earlier one already completed works the same way -- the bridge is not a one-shot listener", () => {
  const { window, windowListeners, posted } = buildContext({
    sendMessage(_message, callback) { callback({ ok: true, token: "token-a", expiresAt: "2026-10-01T00:00:00.000Z" }); },
  });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  dispatchFromPage(windowListeners, window, { type: "FLIP_GROUP_DISCOVERY_REQUEST" });
  assert.equal(posted.length, 4, "two full ACK+result round trips");
  assert.equal(posted[0].message.type, "FLIP_GROUP_DISCOVERY_ACK");
  assert.equal(posted[2].message.type, "FLIP_GROUP_DISCOVERY_ACK");
  assert.equal(posted[3].message.ok, true);
});
