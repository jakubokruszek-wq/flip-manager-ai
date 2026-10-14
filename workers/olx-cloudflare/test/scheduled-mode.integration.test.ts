/**
 * Unattended OLX (scheduled mode): the cloud runner against the fictitious
 * queue over real HTTP (HMAC, nonces, leases), with a local Chromium standing
 * in for Browser Run. Nothing here talks to Supabase, Vercel, Cloudflare or OLX.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach, before, beforeEach } from "node:test";

import { createApiClient } from "../../olx-browser/src/api-client.ts";
import type { Ledger } from "../src/budget.ts";
import { loadCloudConfig, parseCloudConfig, type CloudConfig } from "../src/config.ts";
import { cronPlan } from "../src/cron-plan.ts";
import { createLogger } from "../src/logger.ts";
import { runBatch, type LedgerStore, type RunnerDeps } from "../src/runner.ts";
import { accountBrowserMsToday } from "../src/scheduled-claim-client.ts";
import { FAKE_SECRET, startFakeQueue, type FakeQueue } from "./helpers/fake-queue.ts";
import { localChromium, type FixtureResponse, type LocalChromium } from "./helpers/local-chromium.ts";

const FIXTURE = readFileSync(new URL("./fixtures/olx-lodz-sprzedaz.sample.html", import.meta.url), "utf8");
const OK_PAGE = (): FixtureResponse => ({ status: 200, body: FIXTURE });
const SCHEDULED_TOML = readFileSync(new URL("../wrangler.scheduled.toml", import.meta.url), "utf8");
const tomlVars = Object.fromEntries([...SCHEDULED_TOML.slice(SCHEDULED_TOML.indexOf("[vars]")).matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));
console.info = () => undefined;

let chromium: LocalChromium | null = null;
let queue: FakeQueue;
before(async () => { chromium = await localChromium(); });
after(async () => { await chromium?.close(); });
beforeEach(async () => { queue = await startFakeQueue(); });
afterEach(async () => { await queue.close(); });

/** The production scheduled config (wrangler.scheduled.toml), enabled, pointed at the fake queue. */
function config(overrides: Record<string, string> = {}): CloudConfig {
  const loaded = loadCloudConfig({ ...tomlVars, OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: queue.url, OLX_WORKER_SECRET: FAKE_SECRET, ...overrides });
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.config;
}

function memoryStore(initial?: Ledger): LedgerStore & { value: Ledger | undefined } {
  const store = {
    value: initial,
    async load() { return store.value ? structuredClone(store.value) : undefined; },
    async save(ledger: Ledger) { store.value = structuredClone(ledger); },
  };
  return store;
}

function deps(cfg: CloudConfig, provider: RunnerDeps["provider"], store: LedgerStore, accountMs: () => Promise<number | null> = async () => 0, lines: string[] = []): RunnerDeps {
  const logger = createLogger((line) => lines.push(line));
  return { config: cfg, api: createApiClient({ apiUrl: cfg.apiUrl, secret: cfg.secret, workerId: cfg.workerId, pollIntervalMs: 10_000, once: false }), provider, store, log: logger.log, accountBrowserMs: accountMs };
}

const paths = () => queue.requests.map((request) => request.path);

test("claims only the automatic Finder job through claim-scheduled and completes it; never /claim", async (t) => {
  if (!chromium) { t.skip("local Chromium unavailable"); return; }
  queue.enqueue({ id: "radar-1", idempotencyKey: "radar:olx", contextType: "price_radar", createdAt: Date.now() - 60_000 });
  queue.enqueue({ id: "manual-1", idempotencyKey: "manual:olx", createdAt: Date.now() - 30_000 });
  queue.enqueue({ id: "auto-1", idempotencyKey: "auto:olx", requestedBy: "scheduler" });
  const provider = chromium.provider(OK_PAGE);
  const store = memoryStore();
  const summary = await runBatch(deps(config(), provider, store), { maxJobs: 1, scheduled: true });
  assert.equal(summary.outcome, "max_jobs");
  assert.deepEqual({ claimed: summary.claimed, completed: summary.completed, failed: summary.failed }, { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(queue.jobs.map((job) => [job.id, job.status]), [["radar-1", "queued"], ["manual-1", "queued"], ["auto-1", "completed"]]);
  assert.equal(queue.jobs[2].workerId, "cloudflare-olx-scheduled");
  assert.ok(!paths().includes("/api/olx-worker/claim"), "the regular claim (oldest job, lease recovery, Radar) is never used");
  assert.ok(!paths().includes("/api/olx-worker/claim-selective"));
  assert.equal(provider.stats.launches, 1);
  assert.equal(summary.accountBrowserMs, 0);
  assert.deepEqual(queue.authFailures, []);
  assert.equal(store.value?.jobsClaimed, 1);
});

test("second tick the same UTC day: the Worker's own 1-job cap stops before any request", async (t) => {
  if (!chromium) { t.skip("local Chromium unavailable"); return; }
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  const store = memoryStore();
  const provider = chromium.provider(OK_PAGE);
  await runBatch(deps(config(), provider, store), { maxJobs: 1, scheduled: true });
  queue.enqueue({ id: "auto-2", idempotencyKey: "b:olx", requestedBy: "scheduler" });
  const before = queue.requests.length;
  const second = await runBatch(deps(config(), provider, store), { maxJobs: 1, scheduled: true });
  assert.equal(second.outcome, "paused");
  assert.equal(second.stop?.code, "OLX_CLOUD_DAILY_JOB_CAP_REACHED");
  assert.equal(queue.requests.length, before, "no claim, no rejection");
  assert.equal(queue.jobs[1].status, "queued");
});

test("STOP in the database: AUTOMATION_DISABLED, nothing claimed, no browser", async () => {
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  queue.setAutomationEnabled(false);
  const launches = { count: 0 };
  const provider = { launch: async () => { launches.count += 1; throw new Error("must not launch"); } };
  const summary = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, scheduled: true });
  assert.equal(summary.outcome, "idle");
  assert.equal(summary.claimReason, "AUTOMATION_DISABLED");
  assert.equal(launches.count, 0);
  assert.equal(queue.jobs[0].status, "queued");
});

test("account-wide browser usage (history) over the safe budget or unknown: no claim request at all", async () => {
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  const provider = { launch: async () => { throw new Error("must not launch"); } };
  // Stage-2 test or another Worker already used 90 s today; 90 + 35 reserve > 120.
  const spent = await runBatch(deps(config(), provider, memoryStore(), async () => 90_000), { maxJobs: 1, scheduled: true });
  assert.equal(spent.outcome, "paused");
  assert.equal(spent.stop?.code, "OLX_CLOUD_ACCOUNT_BUDGET_EXHAUSTED");
  for (const unknown of [async () => null, async () => { throw new Error("history() 500"); }, async () => Number.NaN]) {
    const summary = await runBatch(deps(config(), provider, memoryStore(), unknown), { maxJobs: 1, scheduled: true });
    assert.equal(summary.stop?.code, "OLX_CLOUD_ACCOUNT_USAGE_UNKNOWN");
  }
  assert.deepEqual(paths(), [], "fail closed: the queue was never asked");
  assert.equal(queue.jobs[0].status, "queued");
});

test("the Worker's own ledger counts too: the larger of ledger and history decides", async () => {
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  const today = new Date().toISOString().slice(0, 10);
  const ledger: Ledger = { day: today, browserMs: 100_000, sessions: 1, jobsClaimed: 0, jobsCompleted: 0, jobsFailed: 0, jobsRejected: 0, refusalStreak: 0, openSession: null, stop: null };
  const summary = await runBatch(deps(config(), { launch: async () => { throw new Error("no"); } }, memoryStore(ledger), async () => 0), { maxJobs: 1, scheduled: true });
  assert.equal(summary.outcome, "paused");
  assert.deepEqual(paths(), []);
});

test("an OLX access pause (refusal) blocks scheduled claims for 24 h; paused never claims to reject", async (t) => {
  if (!chromium) { t.skip("local Chromium unavailable"); return; }
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  const store = memoryStore();
  const refused = chromium.provider(() => ({ status: 403, body: "Forbidden" }));
  const first = await runBatch(deps(config(), refused, store), { maxJobs: 1, scheduled: true });
  assert.equal(first.failed, 1);
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_OLX_ACCESS_PAUSED");
  assert.ok(Date.parse(store.value!.stop!.resumesAt) - Date.now() > 23 * 3_600_000);
  queue.enqueue({ id: "auto-2", idempotencyKey: "b:olx", requestedBy: "scheduler" });
  const before = queue.requests.length;
  const second = await runBatch(deps(config(), refused, store), { maxJobs: 1, scheduled: true });
  assert.equal(second.outcome, "paused");
  assert.equal(queue.requests.length, before);
});

test("missing migration (503) or a running OLX job: nothing scraped, reason reported", async () => {
  queue.enqueue({ id: "auto-1", idempotencyKey: "a:olx", requestedBy: "scheduler" });
  const provider = { launch: async () => { throw new Error("must not launch"); } };
  queue.setScheduledAvailable(false);
  const missing = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, scheduled: true });
  assert.equal(missing.claimError, "OLX_SCHEDULED_CLAIM_UNAVAILABLE");
  queue.setScheduledAvailable(true);
  const radar = queue.enqueue({ id: "radar-1", idempotencyKey: "r:olx", contextType: "price_radar" });
  Object.assign(radar!, { status: "running", leasedUntil: Date.now() + 60_000 });
  const busy = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, scheduled: true });
  assert.equal(busy.claimReason, "OLX_JOB_RUNNING");
  assert.equal(queue.jobs[0].status, "queued");
});

test("a job that is not an automatic Finder job is never scraped (defence in depth)", async () => {
  // A broken server answering with a Radar job: the runner refuses it.
  const lines: string[] = [];
  const d = deps(config(), { launch: async () => { throw new Error("must not launch"); } }, memoryStore(), async () => 0, lines);
  d.claimScheduled = async () => ({ job: { id: "r", runId: "r", sourceScanId: null, filterId: null, contextType: "price_radar", radarRunLeaseToken: "t", requestUrl: "https://www.olx.pl/x/", leaseToken: "l", leasedUntil: new Date().toISOString(), attempts: 1 }, reason: null });
  const summary = await runBatch(d, { maxJobs: 1, scheduled: true });
  assert.equal(summary.outcome, "selective_mismatch");
  assert.equal(summary.claimed, 0);
  assert.ok(lines.some((line) => line.includes("OLX_CLOUD_SCHEDULED_CLAIM_MISMATCH")));
});

test("scheduled mode is refused unless the reviewed limits are set", () => {
  const base = { ...tomlVars, OLX_WORKER_SECRET: FAKE_SECRET };
  assert.ok(parseCloudConfig(base).ok, "the committed wrangler.scheduled.toml is valid");
  for (const [key, value] of [["OLX_CLOUD_MAX_JOBS_PER_DAY", "0"], ["OLX_CLOUD_MAX_JOBS_PER_DAY", "2"], ["OLX_CLOUD_MAX_HELD_JOBS", "2"], ["OLX_CLOUD_MAX_JOBS_PER_INVOCATION", "2"], ["OLX_CLOUD_ON_BUDGET_EXHAUSTED", "fail_jobs"], ["OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS", "900"], ["OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS", "400"]]) {
    const result = parseCloudConfig({ ...base, [key]: value });
    assert.equal(result.ok, false, `${key}=${value} must be refused`);
  }
});

test("Cron plan: disabled/manual disarm; scheduled arms one alarm, never while running or pending; auto unchanged", () => {
  const now = Date.parse("2026-10-15T07:45:00Z");
  const enabled = loadCloudConfig({ ...tomlVars, OLX_CLOUD_ENABLED: "1", OLX_WORKER_SECRET: FAKE_SECRET });
  const disabled = loadCloudConfig({ ...tomlVars, OLX_WORKER_SECRET: FAKE_SECRET });
  assert.deepEqual(cronPlan(disabled, now + 5_000, now, false), { action: "disarm", code: "OLX_CLOUD_DISABLED" }, "as deployed (OFF) nothing ever runs");
  assert.deepEqual(cronPlan(enabled, null, now, false), { action: "arm", atMs: now + 1_000, reason: "scheduled_claim" });
  assert.deepEqual(cronPlan(enabled, now + 500, now, false), { action: "keep" }, "a pending alarm is not doubled");
  assert.deepEqual(cronPlan(enabled, null, now, true), { action: "keep" }, "never while a batch runs");
  assert.deepEqual(cronPlan(enabled, now - 200_000, now, false).action, "arm", "a stuck alarm is replaced");
  const manual = loadCloudConfig({ ...tomlVars, OLX_CLOUD_ENABLED: "1", OLX_CLOUD_CLAIM_MODE: "manual", OLX_CLOUD_MAX_JOBS_PER_DAY: "1", OLX_WORKER_SECRET: FAKE_SECRET });
  assert.equal(cronPlan(manual, null, now, false).action, "disarm");
  const auto = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_CLOUD_CLAIM_MODE: "auto", OLX_WORKER_API_URL: "https://x.example", OLX_WORKER_SECRET: FAKE_SECRET });
  assert.deepEqual(cronPlan(auto, null, now, false), { action: "arm", atMs: now + 1_000, reason: "auto_poll" });
  assert.deepEqual(cronPlan(auto, now + 10_000, now, false), { action: "keep" });
});

test("account usage from history(): only today's UTC part, open sessions until now", () => {
  const now = Date.parse("2026-10-15T08:00:00Z");
  const midnight = Date.parse("2026-10-15T00:00:00Z");
  assert.equal(accountBrowserMsToday([
    { startTime: midnight - 60_000, endTime: midnight + 30_000 }, // crosses midnight: 30 s
    { startTime: midnight + 3_600_000, endTime: midnight + 3_660_000 }, // 60 s
    { startTime: now - 20_000, endTime: null }, // open: 20 s
    { startTime: midnight - 7_200_000, endTime: midnight - 3_600_000 }, // yesterday: 0
  ], now), 110_000);
  assert.equal(accountBrowserMsToday([], now), 0);
});

test("resource model: 96 Cron ticks/day; at most 1 job and 120 s of 600 s browser time per day", () => {
  assert.match(SCHEDULED_TOML, /^crons = \["\*\/15 \* \* \* \*"\]$/m);
  const ticks = 24 * 60 / 15;
  assert.equal(ticks, 96);
  // Per tick while enabled: 1 history() + 1 claim-scheduled (Vercel). Per job: ~3 heartbeats + 1 complete + 1 session.
  const vercelCallsPerDay = ticks + 4;
  assert.ok(vercelCallsPerDay <= 100, "≈ 3 000 Vercel invocations per month");
  assert.equal(Number(tomlVars.OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS), 120);
  assert.ok(120 / 600 <= 0.2, "at most 20% of the account's free browser time");
});
