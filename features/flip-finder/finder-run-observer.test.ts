import assert from "node:assert/strict";
import test, { mock } from "node:test";

let handler: (url: string, init: RequestInit) => Promise<Response>;
const calls: Array<{ url: string; method: string }> = [];
mock.module("@/lib/api-fetch", { namedExports: { apiFetch: (url: string, init: RequestInit) => { calls.push({ url, method: init.method ?? "GET" }); return handler(url, init); } } });
const { observeFinderRuns } = await import("./finder-run-observer.ts");
function snapshot(runId: string, waiting = false) {
  return { runId, status: waiting ? "partial" : "completed", overall: { remainingUnits: waiting ? 1 : 0, waitingUnits: waiting ? 1 : 0 }, facebook: { totalGroups: 0, groups: [] }, olx: { status: null }, openai: {} };
}
const response = (payload: unknown, status = 200) => Promise.resolve(Response.json(payload, { status }));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

test("GET observer discovers later runs, stops terminal progress polling and keeps only light discovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  calls.length = 0;
  let current: string | null = null;
  handler = (url) => response(url.endsWith("latest-run") ? { runId: current } : snapshot(current!));
  const controller = new AbortController();
  const observed: Array<string | null> = [];
  const promise = observeFinderRuns("filter-A", controller.signal, { onProgress: (p) => observed.push(p?.runId ?? null), onError: () => {}, discoveryIntervalMs: 100, progressIntervalMs: 10 });
  await flush();
  assert.equal(calls.length, 1);
  current = "first"; t.mock.timers.tick(100); await flush();
  assert.deepEqual(observed, [null, "first"]);
  const progressCount = calls.filter((c) => c.url.includes("/scans/")).length;
  t.mock.timers.tick(100); await flush();
  assert.equal(calls.filter((c) => c.url.includes("/scans/")).length, progressCount, "terminal details are not polled again");
  current = "second"; t.mock.timers.tick(100); await flush();
  assert.equal(observed.at(-1), "second");
  assert.ok(calls.every((c) => c.method === "GET" && !/\/continue|\/scan$|\/cancel|\/results$/.test(c.url)));
  controller.abort(); await promise;
  const stoppedCount = calls.length;
  t.mock.timers.tick(1_000); await flush();
  assert.equal(calls.length, stoppedCount, "unmount cancels discovery timer as well");
});

test("waiting partial is still observed using GET and becomes terminal partial without any POST continuation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] }); calls.length = 0;
  let waiting = true;
  handler = (url) => response(url.endsWith("latest-run") ? { runId: "waiting" } : snapshot("waiting", waiting));
  const controller = new AbortController();
  const states: boolean[] = [];
  const promise = observeFinderRuns("filter", controller.signal, { onProgress: (p) => { if (p) states.push((p.overall.waitingUnits ?? 0) > 0); }, onError: () => {}, discoveryIntervalMs: 100, progressIntervalMs: 10 });
  await flush(); waiting = false; t.mock.timers.tick(10); await flush();
  assert.deepEqual(states, [true, false]);
  t.mock.timers.tick(20); await flush();
  assert.equal(states.length, 2);
  assert.ok(calls.every((c) => c.method === "GET"));
  controller.abort(); await promise;
});

test("aborting an in-flight read on filter change suppresses its stale callback and further polls", async () => {
  calls.length = 0;
  let resolveRead: (r: Response) => void = () => {};
  handler = () => new Promise((resolve) => { resolveRead = resolve; });
  const controller = new AbortController();
  const observed: unknown[] = [];
  const promise = observeFinderRuns("old-filter", controller.signal, { onProgress: (p) => observed.push(p), onError: () => {} });
  controller.abort(); resolveRead(Response.json({ runId: "old-run" })); await promise;
  assert.deepEqual(observed, []);
  assert.equal(calls.length, 1);
});

test("an unreadable backend is reported as an error instead of claiming that a scan is active or complete", async () => {
  calls.length = 0;
  handler = () => response({ error: "offline" }, 500);
  const controller = new AbortController();
  const errors: string[] = [];
  const promise = observeFinderRuns("filter", controller.signal, { onProgress: () => assert.fail("failed read cannot invent progress"), onError: (message) => { if (message) errors.push(message); controller.abort(); } });
  await promise;
  assert.equal(errors.length, 1);
});
