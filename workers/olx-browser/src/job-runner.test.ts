import assert from "node:assert/strict";
import test from "node:test";
import { ControlledOlxFailure } from "./retry.ts";
import { runOlxJob } from "./job-runner.ts";
import type { WorkerJob } from "./api-client.ts";

const job: WorkerJob = {
  id: "job-1", runId: "radar-run-1", sourceScanId: null, filterId: null, contextType: "price_radar", radarOwnerId: "owner-1",
  radarRunLeaseToken: "radar-secret-token", radarLeaseUntil: "2099-10-10T10:00:00.000Z",
  requestUrl: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", leaseToken: "job-secret-token",
  leasedUntil: "2099-10-10T10:00:00.000Z", attempts: 1,
};

function result() {
  return {
    diagnostics: { status: 200, finalUrl: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", title: "OLX", bodyLength: 50, marker: true },
    rawItems: 1, normalizedItems: 1, listings: [{ source: "olx" }], warnings: [], durationMs: 10,
  };
}

test("worker logs the server's distinct job/Radar expiries, final-heartbeats before completion, and never logs lease tokens", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  let heartbeatCount = 0;
  let completeCalled = false;
  const api = {
    async heartbeat() { heartbeatCount += 1; return { jobLeasedUntil: "2031-01-01T00:02:00.000Z", radarLeaseUntil: "2031-01-01T00:02:00.000Z" }; },
    async complete() { assert.equal(heartbeatCount, 2, "both initial ownership validation and the final DB heartbeat must finish before finalization"); completeCalled = true; },
    async fail() { throw new Error("unexpected fail"); },
  };
  const outcome = await runOlxJob({
    job, api: api as never, scrape: async () => result(), shutdownSignal: new AbortController().signal,
    heartbeatIntervalMs: 60_000, log: (event, data) => events.push([event, data]),
  });
  assert.equal(outcome, "completed");
  assert.equal(completeCalled, true);
  const heartbeatLog = events.find(([event]) => event === "JOB_HEARTBEAT")?.[1];
  assert.deepEqual(heartbeatLog, { jobId: "job-1", jobLeasedUntil: "2031-01-01T00:02:00.000Z", radarLeaseUntil: "2031-01-01T00:02:00.000Z" });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(job.leaseToken), false);
  assert.equal(serialized.includes(job.radarRunLeaseToken!), false);
});

test("a lost heartbeat aborts an active scrape and prevents complete/fail from the stale worker", async () => {
  const controller = new AbortController();
  const events: Array<[string, Record<string, unknown>]> = [];
  let scrapeAborted = false;
  let heartbeatCalls = 0;
  let completeCalls = 0;
  let failCalls = 0;
  const api = {
    async heartbeat() { heartbeatCalls += 1; if (heartbeatCalls === 1) return { jobLeasedUntil: "2099-10-10T10:02:00.000Z", radarLeaseUntil: "2099-10-10T10:02:00.000Z" }; throw new Error("lease token value must not enter logs"); },
    async complete() { completeCalls += 1; },
    async fail() { failCalls += 1; },
  };
  const outcome = await runOlxJob({
    job, api: api as never,
    scrape: async (_url, signal) => new Promise((resolve, reject) => {
      const abort = () => { scrapeAborted = true; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }),
    shutdownSignal: controller.signal, heartbeatIntervalMs: 2, wallClockLimitMs: 100, finalizationLimitMs: 20,
    log: (event, data) => events.push([event, data]),
  });
  assert.equal(outcome, "lease_lost");
  assert.ok(heartbeatCalls >= 2, "the active job is checked at claim start and then renewed while scraping");
  assert.equal(scrapeAborted, true);
  assert.equal(completeCalls, 0);
  assert.equal(failCalls, 0, "a worker that lost either lease no longer owns the right to finalize either row");
  assert.equal(JSON.stringify(events).includes("lease token value"), false);
});

test("a controlled OLX HTTP 403 is reported as a terminal queue failure without a retry", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  let scrapeCalls = 0;
  const failed: Array<[string, string]> = [];
  const api = {
    async heartbeat() { return { jobLeasedUntil: "2099-10-10T10:02:00.000Z", radarLeaseUntil: "2099-10-10T10:02:00.000Z" }; },
    async complete() { throw new Error("must not complete a 403"); },
    async fail(_job: WorkerJob, code: string, message: string) { failed.push([code, message]); },
  };
  const outcome = await runOlxJob({
    job, api: api as never, scrape: async () => { scrapeCalls += 1; throw new ControlledOlxFailure("OLX_HTTP_403", "normal access returned HTTP 403"); },
    shutdownSignal: new AbortController().signal, heartbeatIntervalMs: 60_000,
    log: (event, data) => events.push([event, data]),
  });
  assert.equal(outcome, "failed");
  assert.equal(scrapeCalls, 1, "a controlled access denial is not retried");
  assert.equal(failed[0]?.[0], "OLX_HTTP_403");
});

test("the whole job wall-clock guard aborts scraping and attempts a terminal fail while ownership is still held", async () => {
  let failedCode: string | null = null;
  const api = {
    async heartbeat() { return { jobLeasedUntil: "2099-10-10T10:02:00.000Z", radarLeaseUntil: "2099-10-10T10:02:00.000Z" }; },
    async complete() { throw new Error("must not complete timed-out scrape"); },
    async fail(_job: WorkerJob, code: string) { failedCode = code; },
  };
  const outcome = await runOlxJob({
    job, api: api as never,
    scrape: async (_url, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    shutdownSignal: new AbortController().signal, heartbeatIntervalMs: 60_000, wallClockLimitMs: 5, log: () => undefined,
  });
  assert.equal(outcome, "failed");
  assert.equal(failedCode, "OLX_JOB_DURATION_LIMIT");
});

test("a wall-clock timeout during the next heartbeat still reports failure under the last confirmed lease", async () => {
  let heartbeatCalls = 0;
  let failedCode: string | null = null;
  const api = {
    async heartbeat(_job: WorkerJob, signal?: AbortSignal) {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) return { jobLeasedUntil: "2099-10-10T10:02:00.000Z", radarLeaseUntil: "2099-10-10T10:02:00.000Z" };
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async complete() { throw new Error("must not complete a timed-out scrape"); },
    async fail(_job: WorkerJob, code: string) { failedCode = code; },
  };
  const outcome = await runOlxJob({
    job, api: api as never,
    scrape: async (_url, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    shutdownSignal: new AbortController().signal, heartbeatIntervalMs: 5, wallClockLimitMs: 80, finalizationLimitMs: 20,
    log: () => undefined,
  });
  assert.ok(heartbeatCalls >= 2, "the timeout overlaps a real in-flight fake heartbeat after one confirmed lease renewal");
  assert.equal(outcome, "failed");
  assert.equal(failedCode, "OLX_JOB_DURATION_LIMIT", "an aborted renewal at our own deadline must not suppress terminal failure reporting");
});

test("the configured total job budget reserves a bounded finalization window", async () => {
  const started = Date.now();
  let completeAborted = false;
  let failCalled = false;
  const api = {
    async heartbeat() { return { jobLeasedUntil: "2099-10-10T10:02:00.000Z", radarLeaseUntil: "2099-10-10T10:02:00.000Z" }; },
    async complete(_job: WorkerJob, _result: unknown, signal: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => { clearTimeout(timer); completeAborted = true; reject(signal.reason); }, { once: true });
      });
    },
    async fail() { failCalled = true; },
  };
  const outcome = await runOlxJob({
    job, api: api as never, scrape: async () => result(), shutdownSignal: new AbortController().signal,
    heartbeatIntervalMs: 60_000, wallClockLimitMs: 60, finalizationLimitMs: 20, log: () => undefined,
  });
  assert.equal(outcome, "failed");
  assert.equal(completeAborted, true, "the completion request receives a bounded finalization signal");
  assert.equal(failCalled, false, "an in-flight completion timeout has an uncertain server outcome and must not be raced by a second terminal write");
  assert.ok(Date.now() - started < 120, "work plus finalization is bounded near the configured wall clock");
});
