import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runPriceRadarScheduler } from "./price-radar-scheduler.mjs";

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("the GitHub schedule checks saved Warsaw settings every five minutes and stays isolated from Finder/Watcher/CRM", async () => {
  const workflow = await readFile(new URL("../.github/workflows/price-radar-scan-scheduler.yml", import.meta.url), "utf8");
  const endpoint = await readFile(new URL("../app/api/jobs/price-radar-collect/route.ts", import.meta.url), "utf8");
  const collector = await readFile(new URL("../features/price-radar/server/collect.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("./price-radar-scheduler.mjs", import.meta.url), "utf8");
  assert.match(workflow, /cron:\s*["']\*\/5 \* \* \* \*["']/u);
  assert.doesNotMatch(workflow, /timezone:/u, "the 5-minute tick is UTC-independent; the server applies Europe/Warsaw wall time");
  assert.match(workflow, /group:\s*price-radar-scheduler/u);
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /secrets\.PRICE_RADAR_CRON_SECRET/u);
  assert.match(workflow, /api\/jobs\/price-radar-collect/u);
  assert.doesNotMatch(workflow, /workflow_dispatch|finder-scan|facebook-watch|crm|vercel\.json/iu);
  assert.match(endpoint, /process\.env\.PRICE_RADAR_CRON_SECRET/u);
  assert.match(endpoint, /claimOrCreateRadarRun/u);
  assert.match(endpoint, /runRadarCollectionPortion/u);
  assert.doesNotMatch(endpoint, /facebook_scan_jobs|source_scans|crm/u);
  assert.doesNotMatch(collector, /facebook_scan_jobs|source_scans|crm/u);
  assert.doesNotMatch(collector, /enqueueRadarOlxJob/u, "OLX left Radar: the collector never queues an OLX job");
  assert.match(collector, /RADAR_REMOVED_SOURCES: ReadonlySet<string> = new Set\(\["olx"\]\)/u);
  assert.match(workflow, /MAX_REQUESTS:\s*["']24["']/u);
  assert.match(workflow, /MAX_ELAPSED_MS:\s*["']3300000["']/u);
  assert.match(runner, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/u);
  assert.match(endpoint, /maxDuration = 60;/u);
  assert.match(runner, /REQUEST_TIMEOUT_MS\s*=\s*62_000/u, "an HTTP call must time out just after the endpoint's 60-second function bound");
});

test("the runner resumes durable portions and stops only after an explicit terminal status", async () => {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const responses = [
    json(200, { runId: "same-run", status: "running", scannedCount: 10, qualifiedCount: 1, retryAfterSeconds: 80 }),
    json(200, { runId: "same-run", status: "running", scannedCount: 23, qualifiedCount: 1, retryAfterSeconds: 80 }),
    json(200, { runId: "same-run", status: "partial", scannedCount: 34, qualifiedCount: 2 }),
  ];
  const result = await runPriceRadarScheduler({
    url: "https://example.test/api/jobs/price-radar-collect", secret: "never-log-me",
    fetchImpl: async (...args) => { calls.push(args); return responses.shift(); },
    sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, log: () => {},
    maxRequests: 4, maxElapsedMs: 1_000_000,
  });
  assert.deepEqual(result, { status: "partial", runId: "same-run", requests: 3, terminal: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [80_000, 80_000]);
  assert.ok(calls.every(([url, init]) => url === "https://example.test/api/jobs/price-radar-collect" && init.method === "POST"));
  assert.ok(calls.every(([, init]) => init.headers.authorization === "Bearer never-log-me"));
  assert.equal(calls[0][1].body, "{}");
  assert.equal(calls[1][1].body, JSON.stringify({ runId: "same-run" }));
  assert.equal(calls[2][1].body, JSON.stringify({ runId: "same-run" }));
});

test("not-due and disabled ticks stop successfully without claiming a run or retrying", async () => {
  for (const status of ["not_due", "automation_disabled"]) {
    let calls = 0;
    const result = await runPriceRadarScheduler({
      url: "https://example.test", secret: "secret",
      fetchImpl: async () => { calls += 1; return json(200, { status }); },
      sleepImpl: async () => assert.fail("a no-op schedule tick must not poll or retry"), log: () => {}, now: () => 0,
    });
    assert.deepEqual(result, { status, runId: null, requests: 1, terminal: true });
    assert.equal(calls, 1);
  }
});

test("a missing authorization secret fails before making any network request", async () => {
  let calls = 0;
  await assert.rejects(runPriceRadarScheduler({ url: "https://example.test", secret: "", fetchImpl: async () => { calls += 1; return json(200, {}); } }), /PRICE_RADAR_CRON_SECRET is not configured/u);
  assert.equal(calls, 0);
});

test("retryable HTTP and transport failures are bounded and do not log authorization data", async () => {
  const logs = [];
  const sleeps = [];
  const signals = [];
  let calls = 0;
  const result = await runPriceRadarScheduler({
    url: "https://example.test", secret: "secret-value",
    fetchImpl: async (_url, init) => { calls += 1; signals.push(init.signal); return calls === 1 ? json(503, {}) : json(200, { status: "already_ran_today" }); },
    sleepImpl: async (ms) => { sleeps.push(ms); }, log: (value) => logs.push(value), now: () => 0,
    maxRequests: 4, maxElapsedMs: 60_000,
  });
  assert.equal(result.status, "already_ran_today");
  assert.equal(calls, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.deepEqual(sleeps, [30_000]);
  assert.equal(logs.some((value) => value.includes("secret-value")), false);
});

test("OLX unavailable stops polling honestly without declaring the Radar run complete", async () => {
  let calls = 0;
  const result = await runPriceRadarScheduler({
    url: "https://example.test", secret: "secret",
    fetchImpl: async () => { calls += 1; return json(200, { runId: "run-olx", status: "waiting_for_olx", retryAfterSeconds: 300 }); },
    sleepImpl: async () => assert.fail("must not poll an unavailable separate worker"), log: () => {}, now: () => 0,
  });
  assert.deepEqual(result, { status: "waiting_for_olx", runId: "run-olx", requests: 1, terminal: false });
  assert.equal(calls, 1);
});

test("a single portal error that finishes as partial is not retried as a new run", async () => {
  let calls = 0;
  const result = await runPriceRadarScheduler({
    url: "https://example.test", secret: "secret",
    fetchImpl: async () => { calls += 1; return json(200, { runId: "run-partial", status: "partial", sourceErrors: { domiporta: "HTTP 502" } }); },
    log: () => {}, now: () => 0,
  });
  assert.equal(result.status, "partial");
  assert.equal(calls, 1);
});

test("an all-source terminal HTTP result is required before the runner reports completion", async () => {
  let calls = 0;
  const result = await runPriceRadarScheduler({
    url: "https://example.test", secret: "secret",
    fetchImpl: async () => {
      calls += 1;
      return json(200, { runId: "run-complete", status: "completed", sourceStatuses: { otodom: "completed", morizon: "completed", domiporta: "completed" } });
    },
    log: () => {}, now: () => 0,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.terminal, true);
  assert.equal(calls, 1);
});

test("the runner refuses a checkpoint response that switches to a different run ID", async () => {
  let calls = 0;
  await assert.rejects(runPriceRadarScheduler({
    url: "https://example.test", secret: "secret",
    fetchImpl: async () => { calls += 1; return json(200, { runId: calls === 1 ? "run-a" : "run-b", status: "running" }); },
    sleepImpl: async () => {}, log: () => {}, now: () => 0,
  }), /refused to switch run IDs/u);
  assert.equal(calls, 2);
});

test("transport retries are bounded and keep the same protected endpoint", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await runPriceRadarScheduler({
    url: "https://example.test", secret: "secret",
    fetchImpl: async () => { calls += 1; if (calls === 1) throw new Error("network details must not be logged"); return json(200, { status: "idle" }); },
    sleepImpl: async (ms) => { sleeps.push(ms); }, log: () => {}, now: () => 0,
  });
  assert.equal(result.status, "idle");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [30_000]);
});

test("authorization failures and safe request/time caps stop without reporting completion", async () => {
  let calls = 0;
  await assert.rejects(runPriceRadarScheduler({ url: "https://example.test", secret: "secret", fetchImpl: async () => { calls += 1; return json(401, {}); }, log: () => {} }), /HTTP 401/u);
  assert.equal(calls, 1);

  let time = 0;
  await assert.rejects(runPriceRadarScheduler({
    url: "https://example.test", secret: "secret", maxRequests: 2, maxElapsedMs: 5_000,
    fetchImpl: async () => json(200, { runId: "run-budget", status: "running", retryAfterSeconds: 80 }),
    sleepImpl: async (ms) => { time += ms; }, now: () => time, log: () => {},
  }), /safe limit after 1 requests/u);

  let requestCount = 0;
  let requestClock = 0;
  await assert.rejects(runPriceRadarScheduler({
    url: "https://example.test", secret: "secret", maxRequests: 2, maxElapsedMs: 300_000,
    fetchImpl: async () => { requestCount += 1; return json(200, { runId: "run-budget", status: "running", retryAfterSeconds: 5 }); },
    sleepImpl: async (ms) => { requestClock += ms; }, now: () => requestClock, log: () => {},
  }), /safe limit after 2 requests/u);
  assert.equal(requestCount, 2);
});

test("a 409 from the exact-run continuation means another worker owns the run, not a scheduler failure", async () => {
  const logs = [];
  const responses = [
    json(200, { runId: "same-run", status: "running", scannedCount: 440, qualifiedCount: 27, retryAfterSeconds: 80 }),
    json(409, { runId: "same-run", status: "run_changed" }),
  ];
  const result = await runPriceRadarScheduler({
    url: "https://radar.test/api/jobs/price-radar-collect", secret: "secret",
    fetchImpl: async () => responses.shift(), sleepImpl: async () => undefined, now: () => 0, log: (line) => logs.push(line),
  });
  assert.deepEqual(result, { status: "run_changed", runId: "same-run", requests: 2, terminal: true });
  assert.match(logs.at(-1), /continued by another worker/u);
});

test("a user-terminated or no-longer-active run stops the runner cleanly", async () => {
  for (const status of ["user_terminated", "run_not_active"]) {
    const result = await runPriceRadarScheduler({
      url: "https://radar.test/api/jobs/price-radar-collect", secret: "secret",
      fetchImpl: async () => json(200, { runId: "same-run", status, terminal: true }), sleepImpl: async () => undefined, now: () => 0, log: () => undefined,
    });
    assert.equal(result.status, status);
    assert.equal(result.terminal, true);
  }
});
