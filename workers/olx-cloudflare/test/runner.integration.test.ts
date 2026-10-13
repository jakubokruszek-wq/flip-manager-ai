/**
 * Step 2: the cloud runner against a fictitious queue over real HTTP (HMAC,
 * nonces, leases, heartbeats) with a local Chromium standing in for Browser
 * Run. Nothing here talks to Supabase, Vercel, Cloudflare or OLX.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, afterEach, before, beforeEach } from "node:test";

import { createApiClient } from "../../olx-browser/src/api-client.ts";
import type { Ledger } from "../src/budget.ts";
import { loadCloudConfig, type CloudConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { runBatch, type LedgerStore, type RunnerDeps } from "../src/runner.ts";
import type { BrowserProvider } from "../src/browser-session.ts";
import { buildChallengePage } from "./fixtures/generate-olx-fixture.ts";
import { FAKE_SECRET, startFakeQueue, type FakeQueue } from "./helpers/fake-queue.ts";
import { localChromium, type FixtureResponse, type LocalChromium } from "./helpers/local-chromium.ts";

const FIXTURE = readFileSync(new URL("./fixtures/olx-lodz-sprzedaz.sample.html", import.meta.url), "utf8");
const OK_PAGE = (): FixtureResponse => ({ status: 200, body: FIXTURE });
console.info = () => undefined;

let chromium: LocalChromium | null = null;
let queue: FakeQueue;
before(async () => { chromium = await localChromium(); });
after(async () => { await chromium?.close(); });
beforeEach(async () => { queue = await startFakeQueue(); });
afterEach(async () => { await queue.close(); });

function config(overrides: Record<string, string> = {}): CloudConfig {
  const loaded = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: queue.url, OLX_WORKER_SECRET: FAKE_SECRET, OLX_CLOUD_WORKER_ID: "cloudflare-test-1", ...overrides });
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.config;
}

function memoryStore(initial?: Ledger): LedgerStore & { value: Ledger | undefined; writes: number } {
  const store = {
    value: initial,
    writes: 0,
    async load() { return store.value ? structuredClone(store.value) : undefined; },
    async save(ledger: Ledger) { store.writes += 1; store.value = structuredClone(ledger); },
  };
  return store;
}

function deps(cfg: CloudConfig, provider: BrowserProvider, store: LedgerStore, lines: string[] = []): RunnerDeps {
  const logger = createLogger((line) => lines.push(line));
  return { config: cfg, api: createApiClient({ apiUrl: cfg.apiUrl, secret: cfg.secret, workerId: cfg.workerId, pollIntervalMs: 10_000, once: false }), provider, store, log: logger.log };
}

function today(partial: Partial<Ledger>): Ledger {
  return { day: new Date().toISOString().slice(0, 10), browserMs: 0, sessions: 0, jobsClaimed: 0, jobsCompleted: 0, jobsFailed: 0, jobsRejected: 0, refusalStreak: 0, openSession: null, stop: null, ...partial };
}

function requireChromium(t: { skip(message: string): void }): LocalChromium | null {
  if (!chromium) t.skip("local Chromium unavailable");
  return chromium;
}

test("claims Finder and Radar jobs, scrapes them in ONE browser session and completes them with verified listings", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ id: "finder-1", idempotencyKey: "scan-a:olx" });
  queue.enqueue({ id: "finder-2", idempotencyKey: "scan-b:olx" });
  queue.enqueue({ id: "radar-1", idempotencyKey: "radar-run-1:olx", contextType: "price_radar" });
  const provider = browser.provider(OK_PAGE);
  const store = memoryStore();
  const lines: string[] = [];

  const summary = await runBatch(deps(config({ OLX_CLOUD_MAX_HELD_JOBS: "3", OLX_CLOUD_MAX_JOBS_PER_INVOCATION: "3" }), provider, store, lines));

  assert.equal(summary.outcome, "max_jobs");
  assert.deepEqual({ claimed: summary.claimed, completed: summary.completed, failed: summary.failed }, { claimed: 3, completed: 3, failed: 0 });
  assert.equal(provider.stats.launches, 1, "one Browser Run session for all held jobs (Free: 1 new browser / 20 s)");
  assert.equal(provider.stats.closes, 1);
  assert.equal(provider.stats.olxRequests.length, 3);
  assert.deepEqual(queue.jobs.map((job) => job.status), ["completed", "completed", "completed"]);
  assert.deepEqual(queue.authFailures, [], "every request carried a valid HMAC signature and a fresh nonce");

  const completion = queue.jobs[0].completion as { fetched: number; listings: Array<Record<string, unknown>>; warnings: string[]; workerId: string };
  assert.equal(completion.fetched, 40);
  assert.equal(completion.listings.length, 40);
  assert.deepEqual(completion.warnings, []);
  assert.equal(completion.workerId, "cloudflare-test-1");
  const first = completion.listings[0];
  assert.deepEqual(
    { price: first.price, area: first.area, rooms: first.rooms, district: first.district, publishedAt: first.publishedAt, buildingType: first.buildingType, url: first.originalUrl },
    { price: 250_000, area: 28, rooms: 1, district: "Bałuty", publishedAt: "2026-10-12T12:00:00.000Z", buildingType: "blok", url: "https://www.olx.pl/d/oferta/mieszkanie-one-pokoje-baluty-CID3-IDLFLS.html" },
  );
  assert.ok((queue.jobs[2].completion as { radarLeaseToken?: string }).radarLeaseToken, "Radar jobs send their run lease");

  assert.equal(store.value?.sessions, 1);
  assert.equal(store.value?.jobsCompleted, 3);
  assert.ok((store.value?.browserMs ?? 0) > 0, "browser time is charged");
  assert.equal(store.value?.openSession, null);

  const log = lines.join("\n");
  for (const job of queue.jobs) assert.ok(!log.includes(String(job.radarLeaseToken ?? "@@none@@")), "no Radar lease token in logs");
  assert.ok(!/"leaseToken"/.test(log), "no lease token field in logs");
  assert.ok(!log.includes(FAKE_SECRET));
  assert.match(log, /"event":"OLX_PAGE_VERIFIED".*"rawItems":40.*"domCards":40/);

  const second = await runBatch(deps(config(), provider, store));
  assert.equal(second.outcome, "idle");
  assert.equal(provider.stats.launches, 1, "an empty queue costs no browser time");
});

test("idempotency: a duplicate enqueue is ignored and a completed job cannot be completed twice", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  assert.ok(queue.enqueue({ id: "job-1", idempotencyKey: "scan-a:olx" }));
  assert.equal(queue.enqueue({ id: "job-1-dup", idempotencyKey: "scan-a:olx" }), null);
  const provider = browser.provider(OK_PAGE);
  const summary = await runBatch(deps(config(), provider, memoryStore()));
  assert.equal(summary.completed, 1);
  assert.equal(provider.stats.olxRequests.length, 1);
  const completes = queue.requests.filter((request) => request.path === "/api/olx-worker/complete");
  assert.equal(completes.length, 1);
  // Replaying the exact signed request is refused by the nonce store.
  const replay = await fetch(`${queue.url}/api/olx-worker/claim`, { method: "POST", body: "{}" });
  assert.equal(replay.status, 401);
});

test("budget exhausted (fail_jobs): no browser is opened and every new job fails with an explicit diagnostic", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  queue.enqueue({ idempotencyKey: "b", contextType: "price_radar" });
  const provider = browser.provider(OK_PAGE);
  const store = memoryStore(today({ browserMs: 470_000 }));

  const summary = await runBatch(deps(config(), provider, store));

  assert.equal(summary.outcome, "paused");
  assert.equal(summary.rejected, 2);
  assert.equal(provider.stats.launches, 0);
  for (const job of queue.jobs) {
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED");
    assert.match(job.errorMessage ?? "", /bezpieczny dzienny budżet przeglądarki \(zużyto 470 s z 480 s; limit planu 600 s\)\. Pobieranie OLX wstrzymane do \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  }
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED");
  assert.equal(store.value?.jobsRejected, 2);
  assert.equal(store.value?.jobsClaimed, 0, "rejections do not count as processed jobs");
});

test("budget exhausted (leave_queued): jobs stay queued for a fallback worker; Finder's 90 s watchdog still bounds them", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  const job = queue.enqueue({ idempotencyKey: "a" });
  const summary = await runBatch(deps(config({ OLX_CLOUD_ON_BUDGET_EXHAUSTED: "leave_queued" }), browser.provider(OK_PAGE), memoryStore(today({ browserMs: 479_000 }))));
  assert.equal(summary.outcome, "paused");
  assert.equal(job?.status, "queued");
  assert.equal(queue.requests.length, 0, "not even a claim");
  assert.equal(queue.runUnclaimedWatchdog(Date.now() + 91_000), 1);
  assert.equal(job?.errorCode, "OLX_WORKER_CLAIM_TIMEOUT");
});

test("the budget runs out in the middle of a batch: the next page is not opened and its job fails cleanly", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ id: "first", idempotencyKey: "a" });
  queue.enqueue({ id: "second", idempotencyKey: "b" });
  const provider = browser.provider(OK_PAGE);
  // Exactly one scrape reserve (35 s) left under the 480 s safe budget.
  const store = memoryStore(today({ browserMs: 445_000 }));

  const summary = await runBatch(deps(config(), provider, store));

  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(provider.stats.olxRequests.length, 1);
  assert.equal(queue.jobs[0].status, "completed");
  assert.equal(queue.jobs[1].errorCode, "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED");
  assert.ok((store.value?.browserMs ?? 0) > 445_000);
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED");
});

test("Browser Run answers 429 (plan allowance gone): the job fails with that code and the runner pauses until UTC midnight", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  const local = browser.provider(OK_PAGE, { failLaunch: () => new Error("Unable to create new browser: code: 429: message: Too Many Requests") });
  const provider: BrowserProvider = { ...local, limits: async () => ({ allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 }) };
  const store = memoryStore();

  await runBatch(deps(config(), provider, store));

  assert.equal(queue.jobs[0].errorCode, "OLX_CLOUD_BROWSER_DAILY_LIMIT_429");
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_BROWSER_DAILY_LIMIT_429");
  assert.equal(store.value?.browserMs, 600_000);

  queue.enqueue({ idempotencyKey: "b" });
  const next = await runBatch(deps(config(), provider, store));
  assert.equal(next.outcome, "paused");
  assert.equal(queue.jobs[1].errorCode, "OLX_CLOUD_BROWSER_DAILY_LIMIT_429");
  assert.match(queue.jobs[1].errorMessage ?? "", /HTTP 429/);
});

test("rate limit of new sessions: the runner waits for Browser Run's next allowed acquisition instead of failing", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  const local = browser.provider(OK_PAGE);
  let limitCalls = 0;
  const provider: BrowserProvider = { ...local, limits: async () => ({ allowedBrowserAcquisitions: limitCalls++ === 0 ? 0 : 1, timeUntilNextAllowedBrowserAcquisition: 1_200 }) };
  const lines: string[] = [];
  const started = Date.now();
  const summary = await runBatch(deps(config(), provider, memoryStore(), lines));
  assert.equal(summary.completed, 1);
  assert.ok(Date.now() - started >= 1_200);
  assert.match(lines.join("\n"), /BROWSER_ACQUIRE_WAIT/);
});

test("OLX refusing access (403 / challenge) ends the job once, without retries or workarounds", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ id: "forbidden", idempotencyKey: "a", requestUrl: "https://www.olx.pl/forbidden/" });
  queue.enqueue({ id: "challenge", idempotencyKey: "b", requestUrl: "https://www.olx.pl/challenge/" });
  const provider = browser.provider((url) => url.includes("forbidden") ? { status: 403, body: "<title>Forbidden</title>" } : { status: 200, body: buildChallengePage() });

  await runBatch(deps(config(), provider, memoryStore()));

  assert.equal(queue.jobs.find((job) => job.id === "forbidden")?.errorCode, "OLX_HTTP_403");
  assert.equal(queue.jobs.find((job) => job.id === "challenge")?.errorCode, "OLX_HUMAN_VERIFICATION");
  assert.equal(provider.stats.olxRequests.length, 2, "one request per job");
});

test("a lease revoked while scraping is detected by the final heartbeat: no stale completion is sent", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ id: "job-1", idempotencyKey: "a" });
  const provider = browser.provider(() => { queue.revokeLease("job-1"); return OK_PAGE(); });
  const summary = await runBatch(deps(config(), provider, memoryStore()));
  assert.equal(summary.leaseLost, 1);
  assert.equal(queue.requests.filter((request) => request.path === "/api/olx-worker/complete").length, 0);
  assert.equal(queue.requests.filter((request) => request.path === "/api/olx-worker/fail").length, 0);
});

test("daily job cap for the limited production trial: only the first job is processed", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  queue.enqueue({ idempotencyKey: "b" });
  const store = memoryStore();
  const cfg = config({ OLX_CLOUD_MAX_JOBS_PER_DAY: "1", OLX_CLOUD_MAX_HELD_JOBS: "1", OLX_CLOUD_ON_BUDGET_EXHAUSTED: "leave_queued" });
  const summary = await runBatch(deps(cfg, browser.provider(OK_PAGE), store));
  assert.equal(summary.completed, 1);
  assert.deepEqual(queue.jobs.map((job) => job.status), ["completed", "queued"]);
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_DAILY_JOB_CAP_REACHED");
  // Raising the cap takes effect immediately, without waiting for midnight.
  const resumed = await runBatch(deps(config({ OLX_CLOUD_MAX_JOBS_PER_DAY: "2" }), browser.provider(OK_PAGE), store));
  assert.equal(resumed.completed, 1);
  assert.deepEqual(queue.jobs.map((job) => job.status), ["completed", "completed"]);
  assert.match(store.value?.stop?.message ?? "", /dzienny limit zadań \(2\/2\)/);
});

test("Workers Free CPU: one invocation takes at most OLX_CLOUD_MAX_JOBS_PER_INVOCATION jobs (default 2)", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  for (const key of ["a", "b", "c"]) queue.enqueue({ idempotencyKey: key });
  const summary = await runBatch(deps(config(), browser.provider(OK_PAGE), memoryStore()));
  assert.equal(summary.outcome, "max_jobs");
  assert.equal(summary.completed, 2);
  assert.deepEqual(queue.jobs.map((job) => job.status), ["completed", "completed", "queued"]);
});

test("run-once semantics: maxJobs=1 leaves the rest of the queue untouched", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  queue.enqueue({ idempotencyKey: "b" });
  const summary = await runBatch(deps(config(), browser.provider(OK_PAGE), memoryStore()), { maxJobs: 1 });
  assert.equal(summary.outcome, "max_jobs");
  assert.deepEqual(queue.jobs.map((job) => job.status), ["completed", "queued"]);
});

test("Free-plan subrequest allowance: claiming stops early and the rest is left for the next invocation", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  for (const key of ["a", "b", "c"]) queue.enqueue({ idempotencyKey: key });
  const summary = await runBatch(deps(config({ OLX_CLOUD_MAX_HELD_JOBS: "3", OLX_CLOUD_MAX_JOBS_PER_INVOCATION: "3" }), browser.provider(OK_PAGE), memoryStore()), { subrequestLimit: 16 });
  assert.equal(summary.outcome, "subrequest_limit");
  assert.ok(summary.subrequests <= 16, `used ${summary.subrequests}`);
  assert.ok(queue.jobs.some((job) => job.status === "queued"));
  assert.ok(queue.jobs.every((job) => job.status === "queued" || job.status === "completed"));
});

test("an unreachable queue API is a logged poll error, not a crash, and costs no browser time", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.failNextRequests("/api/olx-worker/claim", 1);
  queue.enqueue({ idempotencyKey: "a" });
  const provider = browser.provider(OK_PAGE);
  const lines: string[] = [];
  const summary = await runBatch(deps(config(), provider, memoryStore(), lines));
  assert.equal(summary.outcome, "idle");
  assert.equal(provider.stats.launches, 0);
  assert.match(lines.join("\n"), /WORKER_POLL_ERROR/);
});

test("a wrong shared secret is rejected by the queue and nothing is processed", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a" });
  const summary = await runBatch(deps(config({ OLX_WORKER_SECRET: "another-secret-that-is-at-least-32-chars" }), browser.provider(OK_PAGE), memoryStore()));
  assert.equal(summary.claimed, 0);
  assert.deepEqual(queue.authFailures, ["INVALID_SIGNATURE"]);
  assert.equal(queue.jobs[0].status, "queued");
});

test("a session left open by a crashed runner is charged on recovery, and a new UTC day starts from zero", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  const crashed = memoryStore(today({ browserMs: 100_000, openSession: { startedAt: Date.now() - 10_000, sessionId: "lost" } }));
  await runBatch(deps(config(), browser.provider(OK_PAGE), crashed));
  // 10 s open + 20 s keep_alive (worst case before Browser Run reaps it).
  assert.ok((crashed.value?.browserMs ?? 0) >= 130_000 && (crashed.value?.browserMs ?? 0) < 131_000, String(crashed.value?.browserMs));
  assert.equal(crashed.value?.openSession, null);

  queue.enqueue({ idempotencyKey: "a" });
  const yesterday = memoryStore({ ...today({ browserMs: 600_000, stop: { code: "OLX_CLOUD_BROWSER_DAILY_LIMIT_429", message: "x", at: "2000-01-01T00:00:00.000Z", resumesAt: "2000-01-02T00:00:00.000Z" } }), day: "2000-01-01" });
  const summary = await runBatch(deps(config(), browser.provider(OK_PAGE), yesterday));
  assert.equal(summary.completed, 1);
  assert.equal(yesterday.value?.stop, null);
  assert.equal(yesterday.value?.day, new Date().toISOString().slice(0, 10));
});

test("disabled or misconfigured worker never claims", () => {
  assert.deepEqual(loadCloudConfig({ OLX_CLOUD_ENABLED: "0" }).ok, false);
  const missing = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: "https://app.example", OLX_WORKER_SECRET: "short" });
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.code === "OLX_CLOUD_CONFIG_INVALID" && !missing.message.includes("short"), "the message never echoes a secret");
  const overBudget = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: "https://app.example", OLX_WORKER_SECRET: FAKE_SECRET, OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS: "700" });
  assert.equal(overBudget.ok, false);
  const plainHttp = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: "http://app.example", OLX_WORKER_SECRET: FAKE_SECRET });
  assert.equal(plainHttp.ok, false);
  const tooSlow = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: "https://app.example", OLX_WORKER_SECRET: FAKE_SECRET, OLX_CLOUD_IDLE_POLL_SECONDS: "60" });
  assert.equal(tooSlow.ok, false, "an idle poll above 45 s could miss Finder's 90 s claim window");
});

/** Browser stand-in whose page returns a crafted in-page result (for failures a real page cannot easily produce). */
function craftedProvider(header: Record<string, unknown>, options: { status?: number } = {}): BrowserProvider & { launches: number } {
  const page = { title: "t", finalUrl: "https://www.olx.pl/nieruchomosci/", htmlLength: 1, marker: true, challenge: false, domCards: null, stateSource: "inline-script", adsShape: "array", stateError: null, meta: { totalElements: null, visibleTotalCount: null, totalPages: null, pageNumber: null } };
  const provider = {
    launches: 0,
    async launch() {
      provider.launches += 1;
      return {
        sessionId: null,
        browser: {
          async newContext() {
            return {
              async newPage() {
                return {
                  async goto() { return { status: () => options.status ?? 200, ok: () => (options.status ?? 200) < 400 }; },
                  async evaluate(expression: string) { if (expression === "1 + 1") return 2; return `${JSON.stringify({ rawItems: 0, normalizedItems: 0, warnings: [], verification: null, fixReport: null, error: null, ...header, page: { ...page, ...(header.page as object | undefined) } })}\nnull`; },
                };
              },
              async close() {},
            };
          },
          async close() {},
        },
      };
    },
  };
  return provider as BrowserProvider & { launches: number };
}

test("an unexpected in-page parser failure ends the job explicitly and is never re-parsed in the Worker (CPU limit)", async () => {
  queue.enqueue({ idempotencyKey: "a" });
  const lines: string[] = [];
  const summary = await runBatch(deps(config(), craftedProvider({ error: "TypeError: Cannot read properties of undefined" }), memoryStore(), lines));
  assert.equal(summary.failed, 1);
  assert.equal(queue.jobs[0].errorCode, "OLX_CLOUD_IN_PAGE_PARSER_FAILED");
  assert.match(queue.jobs[0].errorMessage ?? "", /bez parsowania w Workerze/);
  assert.equal(queue.requests.filter((request) => request.path === "/api/olx-worker/complete").length, 0);
  assert.doesNotMatch(lines.join("\n"), /FALLBACK/);
});

test("a Finder parser error keeps its own message (same as the local worker)", async () => {
  queue.enqueue({ idempotencyKey: "a" });
  await runBatch(deps(config(), craftedProvider({ error: "OLX_PARSER_SHAPE_CHANGED" }), memoryStore()));
  assert.equal(queue.jobs[0].errorCode, "OLX_WORKER_ERROR");
  assert.equal(queue.jobs[0].errorMessage, "OLX_PARSER_SHAPE_CHANGED");
});

test("a redirect away from olx.pl is not parsed", async () => {
  queue.enqueue({ idempotencyKey: "a" });
  await runBatch(deps(config(), craftedProvider({ page: { finalUrl: "https://login.example.com/" } }), memoryStore()));
  assert.equal(queue.jobs[0].errorCode, "OLX_CLOUD_UNEXPECTED_REDIRECT");
});

test("automatic pause: repeated OLX refusals stop all fetching for hours, across UTC midnight, with an explicit message", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  for (const key of ["a", "b"]) queue.enqueue({ idempotencyKey: key });
  const provider = browser.provider(() => ({ status: 403, body: "<title>Forbidden</title>" }));
  const store = memoryStore();
  await runBatch(deps(config(), provider, store));
  assert.deepEqual(queue.jobs.map((job) => job.errorCode), ["OLX_HTTP_403", "OLX_HTTP_403"]);
  assert.equal(store.value?.stop?.code, "OLX_CLOUD_OLX_ACCESS_PAUSED");
  assert.match(store.value?.stop?.message ?? "", /OLX odmówił dostępu 2 razy z rzędu \(ostatnio OLX_HTTP_403\)\. .*wstrzymane do/);

  queue.enqueue({ idempotencyKey: "c" });
  const paused = await runBatch(deps(config(), provider, store));
  assert.equal(paused.outcome, "paused");
  assert.equal(provider.stats.olxRequests.length, 2, "no further request to OLX while paused");
  assert.equal(queue.jobs[2].errorCode, "OLX_CLOUD_OLX_ACCESS_PAUSED");

  // A new UTC day resets the browser budget but not the OLX pause.
  const yesterday = { ...(store.value as Ledger), day: "2000-01-01" };
  const { currentLedger } = await import("../src/budget.ts");
  const carried = currentLedger(yesterday, Date.now(), { dailyBrowserLimitMs: 600_000, safeBrowserBudgetMs: 480_000, scrapeReserveMs: 35_000, sessionMaxMs: 45_000, keepAliveMs: 20_000, maxJobsPerDay: 0 });
  assert.equal(carried.browserMs, 0);
  assert.equal(carried.stop?.code, "OLX_CLOUD_OLX_ACCESS_PAUSED");
});

test("a normal page resets the refusal streak (one isolated refusal does not pause)", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "a", requestUrl: "https://www.olx.pl/forbidden/" });
  queue.enqueue({ idempotencyKey: "b" });
  const store = memoryStore();
  await runBatch(deps(config(), browser.provider((url) => url.includes("forbidden") ? { status: 403, body: "x" } : OK_PAGE()), store));
  assert.equal(store.value?.refusalStreak, 0);
  assert.equal(store.value?.stop, null);
});

/** Full state of the jobs that are not part of the trial, to prove they stay byte-for-byte unchanged. */
function untouched(ids: string[]) {
  return JSON.stringify(queue.jobs.filter((job) => ids.includes(job.id)));
}

for (const by of ["filterId", "jobId"] as const) {
  test(`limited trial (selective claim by ${by}): with an older Radar job and an older job of another filter queued, ONLY the test job is processed`, async (t) => {
    const browser = requireChromium(t); if (!browser) return;
    const testFilter = "22222222-2222-4222-8222-222222222222";
    queue.enqueue({ id: "radar-older", idempotencyKey: "r", contextType: "price_radar", createdAt: Date.now() - 180_000 });
    queue.enqueue({ id: "other-filter-older", idempotencyKey: "o", filterId: "33333333-3333-4333-8333-333333333333", createdAt: Date.now() - 120_000 });
    queue.enqueue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", idempotencyKey: "t", filterId: testFilter });
    const others = ["radar-older", "other-filter-older"];
    const before = untouched(others);
    const provider = browser.provider(OK_PAGE);

    const selector = by === "jobId" ? { jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : { filterId: testFilter };
    const summary = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, selector });

    assert.equal(summary.completed, 1);
    assert.equal(summary.claimed, 1);
    assert.equal(queue.jobs[2].status, "completed");
    assert.equal(untouched(others), before, "older Radar and other-filter jobs: same status, attempts, lease, everything");
    assert.deepEqual(queue.jobs.slice(0, 2).map((job) => [job.status, job.attempts, job.errorCode]), [["queued", 0, null], ["queued", 0, null]]);
    assert.equal(provider.stats.olxRequests.length, 1);
    assert.ok(!queue.requests.some((request) => request.path === "/api/olx-worker/claim"), "the regular claim (oldest job) is never called");
    assert.deepEqual(queue.authFailures, []);

    // Nothing left for the selector: the next trial run claims nothing and still touches nothing.
    const again = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, selector });
    assert.equal(again.claimed, 0);
    assert.equal(untouched(others), before);
  });
}

test("limited trial: a selector naming a Radar job claims nothing (selective claim is Finder-only)", async () => {
  queue.enqueue({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", idempotencyKey: "r", contextType: "price_radar" });
  const before = untouched(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
  const summary = await runBatch(deps(config(), craftedProvider({}), memoryStore()), { maxJobs: 1, selector: { jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
  assert.equal(summary.claimed, 0);
  assert.equal(untouched(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]), before);
});

test("limited trial before the migration is applied: the selective endpoint fails closed and nothing is claimed", async () => {
  queue.setSelectiveAvailable(false);
  queue.enqueue({ id: "radar-older", idempotencyKey: "r", contextType: "price_radar" });
  queue.enqueue({ idempotencyKey: "t", filterId: "22222222-2222-4222-8222-222222222222" });
  const before = JSON.stringify(queue.jobs);
  const provider = craftedProvider({});
  const summary = await runBatch(deps(config(), provider, memoryStore()), { maxJobs: 1, selector: { filterId: "22222222-2222-4222-8222-222222222222" } });
  assert.equal(summary.claimed, 0);
  assert.equal(summary.claimError, "OLX_SELECTIVE_CLAIM_UNAVAILABLE");
  assert.equal(provider.launches, 0);
  assert.equal(JSON.stringify(queue.jobs), before);
  assert.ok(!queue.requests.some((request) => request.path === "/api/olx-worker/claim"));
});

test("limited trial: while paused, a manual run claims nothing at all", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "other" });
  const summary = await runBatch(deps(config(), browser.provider(OK_PAGE), memoryStore(today({ browserMs: 479_000 }))), { maxJobs: 1, selector: { filterId: "22222222-2222-4222-8222-222222222222" } });
  assert.equal(summary.outcome, "paused");
  assert.equal(queue.requests.length, 0);
  assert.equal(queue.jobs[0].status, "queued");
});

test("listing id policy: Finder jobs get OLX's stable id, Radar jobs keep the legacy id (until Radar is migrated)", async (t) => {
  const browser = requireChromium(t); if (!browser) return;
  queue.enqueue({ idempotencyKey: "f" });
  queue.enqueue({ idempotencyKey: "r", contextType: "price_radar" });
  await runBatch(deps(config(), browser.provider(OK_PAGE), memoryStore()));
  const id = (index: number) => (queue.jobs[index].completion as { listings: Array<{ externalListingId: string; images: string[] }> }).listings[0];
  assert.equal(id(0).externalListingId, "913400000");
  assert.equal(id(1).externalListingId, "mieszkanie-one-pokoje-baluty-CID3-IDLFLS.html");
  assert.doesNotMatch(id(0).images[0], /%7B/);

  queue.enqueue({ idempotencyKey: "f2" });
  await runBatch(deps(config({ OLX_CLOUD_LISTING_ID_MODE: "legacy" }), browser.provider(OK_PAGE), memoryStore()));
  assert.equal(id(2).externalListingId, "mieszkanie-one-pokoje-baluty-CID3-IDLFLS.html");
});

test("self-test verifies URL, secret and HMAC against the queue API without claiming or changing any job", async () => {
  queue.enqueue({ idempotencyKey: "untouched" });
  const env = { OLX_CLOUD_ENABLED: "0", OLX_WORKER_API_URL: queue.url, OLX_WORKER_SECRET: FAKE_SECRET, OLX_CLOUD_ADMIN_TOKEN: "a".repeat(40) };
  const { runSelfTest } = await import("../src/self-test.ts");
  const noBrowser = craftedProvider({});
  const ok = await runSelfTest(env, { withBrowser: false, browser: noBrowser, ledger: memoryStore() });
  assert.equal((ok.queueApi as { ok: boolean }).ok, true);
  assert.deepEqual(queue.requests.map((request) => `${request.path}:${request.status}`), ["/api/olx-worker/heartbeat:409"]);
  assert.equal(queue.jobs[0].status, "queued");
  assert.equal(queue.jobs[0].attempts, 0);
  assert.equal(noBrowser.launches, 0);
  const config = ok.config as Record<string, unknown>;
  assert.deepEqual({ killSwitch: config.killSwitch, valid: config.valid, workerSecret: config.workerSecret, adminToken: config.adminToken }, { killSwitch: "disabled", valid: true, workerSecret: "set", adminToken: "set" });
  assert.ok(!JSON.stringify(ok).includes(FAKE_SECRET), "no secret in the self-test output");

  const wrong = await runSelfTest({ ...env, OLX_WORKER_SECRET: "another-secret-that-is-at-least-32-chars" }, { withBrowser: false, browser: noBrowser, ledger: memoryStore() });
  assert.deepEqual({ ok: (wrong.queueApi as { ok: boolean }).ok, status: (wrong.queueApi as { status: number }).status }, { ok: false, status: 401 });

  const store = memoryStore();
  const withBrowser = await runSelfTest(env, { withBrowser: true, browser: noBrowser, ledger: store });
  assert.equal(noBrowser.launches, 1);
  assert.equal((store.value?.sessions ?? 0), 1, "the blank browser is charged to the daily ledger");
  assert.ok("browserRun" in withBrowser);
});
