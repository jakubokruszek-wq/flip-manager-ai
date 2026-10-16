import assert from "node:assert/strict";
import test from "node:test";

import { createOlxAccessGuard } from "./access-guard.ts";
import type { WorkerJob } from "./api-client.ts";
import { loadConfig } from "./config.ts";
import { ControlledOlxFailure } from "./retry.ts";
import { log, logLevel } from "./logger.ts";
import { createWorkerMonitor } from "./monitor.ts";
import { createStallWatchdog } from "./watchdog.ts";
import { runWorker } from "./worker.ts";

const SECRET = "unit-test-secret-with-at-least-32-chars";

function makeJob(id: string): WorkerJob {
  return {
    id, runId: `run-${id}`, sourceScanId: `scan-${id}`, filterId: "filter-1", contextType: "finder",
    requestUrl: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", leaseToken: `lease-secret-${id}`,
    leasedUntil: new Date(Date.now() + 120_000).toISOString(), attempts: 1,
  };
}

function scrapeResult(count: number) {
  return {
    diagnostics: { status: 200, finalUrl: "https://www.olx.pl/", title: "OLX", bodyLength: 10, marker: true },
    rawItems: count, normalizedItems: count, listings: Array.from({ length: count }, () => ({ source: "olx" })), warnings: [], durationMs: 5,
  };
}

function fakeApi(jobs: WorkerJob[]) {
  const calls = { claim: 0, heartbeat: 0, complete: [] as string[], fail: [] as Array<[string, string]> };
  return {
    calls,
    api: {
      async claim() { calls.claim += 1; return { job: jobs.shift() ?? null }; },
      async heartbeat() { calls.heartbeat += 1; return { jobLeasedUntil: new Date(Date.now() + 120_000).toISOString(), radarLeaseUntil: null }; },
      async complete(job: WorkerJob) { calls.complete.push(job.id); },
      async fail(job: WorkerJob, code: string) { calls.fail.push([job.id, code]); },
    },
  };
}

const baseConfig = { workerId: "unit-worker", pollIntervalMs: 2_000, once: false, blockCooldownMs: 60_000, maxBlockCooldownMs: 480_000 };

test("worker claims queued jobs, completes them and reports monitoring summaries without lease tokens", async () => {
  const { api, calls } = fakeApi([makeJob("a"), makeJob("b")]);
  const shutdown = new AbortController();
  const events: Array<[string, Record<string, unknown>]> = [];
  const monitor = createWorkerMonitor({ workerId: "unit-worker" });
  const complete = api.complete;
  api.complete = async (job: WorkerJob) => { await complete(job); if (calls.complete.length === 2) shutdown.abort(); };
  await runWorker({
    config: baseConfig, api, monitor, shutdownSignal: shutdown.signal, scrape: async () => scrapeResult(3),
    log: (event, data = {}) => events.push([event, data]),
  });
  assert.deepEqual(calls.complete, ["a", "b"]);
  const summaries = events.filter(([event]) => event === "JOB_SUMMARY").map(([, data]) => data);
  assert.equal(summaries[0]?.outcome, "completed");
  assert.equal(summaries[0]?.rawItems, 3);
  assert.equal(typeof summaries[0]?.durationMs, "number");
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.totals.completed, calls.complete.length);
  assert.equal(snapshot.totals.rawItems, 3 * calls.complete.length);
  assert.ok(snapshot.lastClaimAt);
  assert.equal(JSON.stringify(events).includes("lease-secret"), false);
  assert.equal(events.at(-1)?.[0], "WORKER_STOP");
});

test("an OLX 403 is reported once, then queued jobs are released with OLX_ACCESS_COOLDOWN without opening OLX", async () => {
  const { api, calls } = fakeApi([makeJob("blocked"), makeJob("next")]);
  const shutdown = new AbortController();
  const events: Array<[string, Record<string, unknown>]> = [];
  const monitor = createWorkerMonitor({ workerId: "w" });
  let scrapes = 0;
  const fail = api.fail;
  api.fail = async (job: WorkerJob, code: string) => { await fail(job, code); if (calls.fail.length === 2) shutdown.abort(); };
  await runWorker({
    config: baseConfig, api, monitor, shutdownSignal: shutdown.signal,
    scrape: async () => { scrapes += 1; throw new ControlledOlxFailure("OLX_HTTP_403", "denied"); },
    log: (event, data = {}) => events.push([event, data]),
  });
  assert.equal(scrapes, 1, "OLX is opened once and never retried during the cooldown");
  assert.deepEqual(calls.fail, [["blocked", "OLX_HTTP_403"], ["next", "OLX_ACCESS_COOLDOWN"]]);
  const cooldown = events.find(([event]) => event === "WORKER_OLX_ACCESS_COOLDOWN")?.[1];
  assert.equal(cooldown?.reason, "OLX_HTTP_403");
  assert.equal(cooldown?.durationMs, 60_000);
  assert.equal(events.find(([event]) => event === "JOB_RELEASED_DURING_COOLDOWN")?.[1].reason, "OLX_HTTP_403");
  assert.equal(monitor.snapshot().totals.accessDenied, 1);
  assert.equal(monitor.snapshot().totals.failed, 2);
});

test("poll errors are logged, counted and backed off; shutdown interrupts the idle sleep", async () => {
  let claims = 0;
  const shutdown = new AbortController();
  const events: Array<[string, Record<string, unknown>]> = [];
  const monitor = createWorkerMonitor({ workerId: "w" });
  const started = Date.now();
  const done = runWorker({
    config: baseConfig, monitor, shutdownSignal: shutdown.signal, scrape: async () => scrapeResult(0),
    api: { async claim() { claims += 1; throw new Error("WORKER_API_HTTP_503"); }, heartbeat: async () => { throw new Error("unused"); }, complete: async () => undefined, fail: async () => undefined },
    log: (event, data = {}) => events.push([event, data]),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  shutdown.abort();
  await done;
  assert.equal(claims, 1);
  assert.ok(Date.now() - started < 1_000, "SIGTERM must not wait for the poll backoff");
  assert.equal(events.find(([event]) => event === "WORKER_POLL_ERROR")?.[1].nextPollMs, 4_000);
  assert.equal(monitor.snapshot().consecutivePollErrors, 1);
  assert.equal(monitor.snapshot().lastPollError, "WORKER_API_HTTP_503");
});

test("once mode exits after a single empty claim", async () => {
  const { api, calls } = fakeApi([]);
  await runWorker({ config: { ...baseConfig, once: true }, api, monitor: createWorkerMonitor({ workerId: "w" }), shutdownSignal: new AbortController().signal, scrape: async () => scrapeResult(0), log: () => undefined });
  assert.equal(calls.claim, 1);
});

test("access guard: denial codes pause immediately, other failures after three in a row, success resets", () => {
  let now = 0;
  const guard = createOlxAccessGuard({ baseCooldownMs: 1_000, maxCooldownMs: 4_000, now: () => now });
  assert.equal(guard.record({ outcome: "failed", code: "OLX_WORKER_ERROR" }), null);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_WORKER_ERROR" }), null);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_WORKER_ERROR" })?.reason, "CONSECUTIVE_JOB_FAILURES");
  assert.equal(guard.remainingMs(), 1_000);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_HTTP_429" })?.durationMs, 2_000);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_HUMAN_VERIFICATION" })?.durationMs, 4_000);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_HTTP_403" })?.durationMs, 4_000, "capped");
  assert.equal(guard.record({ outcome: "lease_lost", code: "OLX_JOB_LEASE_LOST" }), null);
  now += 4_000;
  assert.equal(guard.remainingMs(), 0);
  assert.equal(guard.record({ outcome: "completed", code: null }), null);
  assert.equal(guard.record({ outcome: "failed", code: "OLX_HTTP_403" })?.durationMs, 1_000, "a success resets the doubling");
});

test("stall watchdog fires once when an armed step overruns its budget", () => {
  let now = 0;
  const stalls: Array<{ step: string }> = [];
  const watchdog = createStallWatchdog({ onStall: (details) => stalls.push(details), now: () => now, checkIntervalMs: 60_000 });
  watchdog.arm("claim", 100);
  now = 100; watchdog.check();
  assert.equal(stalls.length, 0);
  now = 101; watchdog.check(); watchdog.check();
  assert.deepEqual(stalls.map((stall) => stall.step), ["claim"]);
  watchdog.stop();
});

test("config keeps existing variables, defaults the Railway worker id and validates cooldowns", () => {
  const config = loadConfig({ OLX_WORKER_API_URL: "https://flip.example", OLX_WORKER_SECRET: SECRET, RAILWAY_REPLICA_ID: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  assert.equal(config.workerId, "railway-0f1e2d3c-4b5");
  assert.equal(config.blockCooldownMs, 900_000);
  assert.equal(config.maxBlockCooldownMs, 7_200_000);
  assert.equal(config.statusLogIntervalMs, 300_000);
  assert.equal(loadConfig({ OLX_WORKER_API_URL: "https://flip.example", OLX_WORKER_SECRET: SECRET, OLX_WORKER_ID: "railway-olx", RAILWAY_REPLICA_ID: "x" }).workerId, "railway-olx");
  assert.throws(() => loadConfig({ OLX_WORKER_API_URL: "https://flip.example", OLX_WORKER_SECRET: SECRET, OLX_WORKER_BLOCK_COOLDOWN_MS: "-1" }), /OLX_WORKER_BLOCK_COOLDOWN_MS/);
  assert.throws(() => loadConfig({ OLX_WORKER_API_URL: "http://flip.example", OLX_WORKER_SECRET: SECRET }), /HTTPS/);
});

test("log levels mark errors and safety pauses for log-based alerting", () => {
  assert.equal(logLevel("WORKER_POLL_ERROR"), "error");
  assert.equal(logLevel("WORKER_WATCHDOG_STALL"), "error");
  assert.equal(logLevel("WORKER_OLX_ACCESS_COOLDOWN"), "warn");
  assert.equal(logLevel("JOB_FAIL"), "warn");
  assert.equal(logLevel("WORKER_STATUS"), "info");
});

test("log lines keep the event as the headline and append an error message to it", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    log("JOB_ERROR", { jobId: "j", code: "OLX_WORKER_ERROR", message: "net::ERR_NAME_NOT_RESOLVED" });
    log("WORKER_STATUS", { state: "idle" });
  } finally {
    process.stdout.write = original;
  }
  const [error, status] = writes.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(error?.message, "JOB_ERROR: net::ERR_NAME_NOT_RESOLVED");
  assert.equal(error?.event, "JOB_ERROR");
  assert.equal(error?.level, "error");
  assert.equal(error?.code, "OLX_WORKER_ERROR");
  assert.equal(status?.message, "WORKER_STATUS");
});
