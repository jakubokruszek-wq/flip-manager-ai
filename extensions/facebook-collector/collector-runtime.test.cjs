/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "collector-runtime.js"), "utf8");
const context = vm.createContext({ globalThis: {}, Promise, Error, Date, setTimeout, clearTimeout });
vm.runInContext(source, context);
const runtime = context.globalThis.FlipCollectorRuntime;

test("sendMessageWithTimeout passes immediate and delayed responses", async () => {
  const immediate = await runtime.sendMessageWithTimeout(() => Promise.resolve({ ok: true }), { timeoutMs: 30, diagnostics: { query: "sprzedam", tabId: 1 } });
  assert.deepEqual(immediate.response, { ok: true });
  const delayed = await runtime.sendMessageWithTimeout(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 8)), { timeoutMs: 40, diagnostics: { query: "na sprzedaż", tabId: 1 } });
  assert.deepEqual(delayed.response, { ok: true });
});

test("sendMessageWithTimeout terminates a missing content response with safe diagnostics", async () => {
  await assert.rejects(
    runtime.sendMessageWithTimeout(() => new Promise(() => {}), { timeoutMs: 12, timeoutCode: "COLLECT_SOURCE_RESPONSE_TIMEOUT", diagnostics: { query: "mieszkanie", tabId: 77, source: "lodzsprzedazzakupwynajem" } }),
    (error) => error.message === "COLLECT_SOURCE_RESPONSE_TIMEOUT" && error.diagnostics.query === "mieszkanie" && error.diagnostics.tabId === 77 && error.diagnostics.elapsedMs >= 10,
  );
});

test("source deadline is terminal even when the underlying operation never settles", async () => {
  const deadline = runtime.createDeadline(12);
  await assert.rejects(Promise.race([new Promise(() => {}), deadline.timeout]), { message: "SOURCE_COLLECTION_DEADLINE_EXCEEDED" });
  assert.equal(deadline.isExceeded(), true);
  deadline.cancel();
});

test("sprzedam and na sprzedaż pass, mieszkanie hangs, then source fails and closes without a batch", async () => {
  const events = [];
  let batchCreated = false;
  let failed = false;
  let tabClosed = false;
  async function send(query) {
    events.push(query);
    return runtime.sendMessageWithTimeout(
      () => query === "mieszkanie" ? new Promise(() => {}) : Promise.resolve({ ok: true }),
      { timeoutMs: 12, timeoutCode: "COLLECT_SOURCE_RESPONSE_TIMEOUT", diagnostics: { query, tabId: 91, source: "lodzsprzedazzakupwynajem" } },
    );
  }
  try {
    await send("sprzedam");
    await send("na sprzedaż");
    await send("mieszkanie");
    batchCreated = true;
  } catch (error) {
    failed = error.message === "COLLECT_SOURCE_RESPONSE_TIMEOUT";
  } finally {
    tabClosed = true;
  }
  assert.deepEqual(events, ["sprzedam", "na sprzedaż", "mieszkanie"]);
  assert.equal(failed, true);
  assert.equal(tabClosed, true);
  assert.equal(batchCreated, false);

  const next = await runtime.sendMessageWithTimeout(() => Promise.resolve({ ok: true }), { timeoutMs: 20, diagnostics: { query: "sprzedam", tabId: 92 } });
  assert.equal(next.response.ok, true);
});

test("timeout diagnostics cannot retain arbitrary credentials", () => {
  const diagnostics = JSON.parse(JSON.stringify(runtime.safeDiagnostics({ query: "mieszkanie", tabId: 4, elapsedMs: 12, source: "group", deviceToken: "secret", cookie: "secret" })));
  assert.deepEqual(diagnostics, { query: "mieszkanie", tabId: 4, elapsedMs: 12, source: "group" });
});
