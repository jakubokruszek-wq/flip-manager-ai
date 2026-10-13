import type { WorkerHeartbeat, WorkerJob } from "../../olx-browser/src/api-client.ts";
import { runOlxJob } from "../../olx-browser/src/job-runner.ts";
import { ControlledOlxFailure } from "../../olx-browser/src/retry.ts";
import { accessPauseStop, budgetStop, canScrape, currentLedger, hardStop, jobCapReached, type BudgetLimits, type BudgetStop, type Ledger } from "./budget.ts";
import type { ListingIdMode } from "./listing-fixes.ts";
import { CloudBrowserSession, type BrowserProvider } from "./browser-session.ts";
import type { CloudConfig } from "./config.ts";
import { createRawCompleter, type RawCompletion } from "./raw-complete.ts";
import { rawListingsJson } from "./raw-listings.ts";

/** The queue API of the Flip Manager app (`/api/olx-worker/*`), HMAC-signed by `createApiClient`. */
export type QueueApi = {
  claim(signal?: AbortSignal): Promise<{ job: WorkerJob | null }>;
  heartbeat(job: WorkerJob, signal?: AbortSignal): Promise<WorkerHeartbeat>;
  complete(job: WorkerJob, result: { fetched: number; listings: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal): Promise<unknown>;
  fail(job: WorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal): Promise<unknown>;
};

export type LedgerStore = {
  load(): Promise<Ledger | undefined>;
  save(ledger: Ledger): Promise<void>;
};

export type RunnerDeps = {
  config: CloudConfig;
  api: QueueApi;
  provider: BrowserProvider;
  store: LedgerStore;
  log(event: string, data: Record<string, unknown>): void;
  now?(): number;
  sleep?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /** Sends browser-produced listings JSON to /complete unparsed; defaults to a signed fetch to config.apiUrl. */
  completeRaw?(job: WorkerJob, result: RawCompletion, signal?: AbortSignal): Promise<unknown>;
  /** Test hook: shorter job timings. */
  jobTimings?: { heartbeatIntervalMs?: number; wallClockLimitMs?: number; finalizationLimitMs?: number };
};

export type BatchOptions = {
  /** Upper bound of jobs claimed in this invocation (the limited production trial uses 1). */
  maxJobs?: number;
  /** Stop claiming new jobs after this much wall time; running jobs still finish. */
  claimWindowMs?: number;
  /** Workers Free allows 50 subrequests per invocation; we keep a margin. */
  subrequestLimit?: number;
  /**
   * Limited-trial guard (manual mode): only a Finder job of this filter may be
   * scraped. Any other claimed job is ended at once with OLX_CLOUD_TEST_FOREIGN_JOB
   * (no browser, no listings written) and claiming stops.
   */
  expectFilterId?: string;
};

export type BatchOutcome = "idle" | "worked" | "paused" | "subrequest_limit" | "claim_window" | "max_jobs" | "foreign_job";

export type BatchSummary = {
  outcome: BatchOutcome;
  claimed: number;
  completed: number;
  failed: number;
  leaseLost: number;
  rejected: number;
  subrequests: number;
  browserLaunches: number;
  stop: BudgetStop | null;
  ledger: Ledger;
};

/** Subrequests one held job may need: claim, ~3 heartbeats, complete or fail, plus margin. */
const SUBREQUESTS_PER_JOB = 6;
/** limits() + acquire + websocket + history() for one browser session. */
const SUBREQUESTS_PER_SESSION = 4;
export const DEFAULT_SUBREQUEST_LIMIT = 45;
export const DEFAULT_CLAIM_WINDOW_MS = 240_000;

/**
 * One scheduler invocation: claim what the queue offers (up to the held-job
 * limit), scrape it through one shared Browser Run session, report results,
 * and stop as soon as the queue is empty, the browser budget is exhausted, or
 * the invocation's subrequest allowance runs low. Never throws for job-level
 * problems; each job ends as complete or fail through the existing API.
 */
export async function runBatch(deps: RunnerDeps, options: BatchOptions = {}): Promise<BatchSummary> {
  const { config, api, store, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const limits = budgetLimits(config);
  const maxJobs = Math.min(options.maxJobs ?? Number.POSITIVE_INFINITY, config.maxJobsPerInvocation);
  const subrequestLimit = options.subrequestLimit ?? DEFAULT_SUBREQUEST_LIMIT;
  const claimDeadline = now() + (options.claimWindowMs ?? DEFAULT_CLAIM_WINDOW_MS);
  const shutdown = new AbortController();

  const stored = await store.load();
  let ledger = currentLedger(stored, now(), limits);
  let saving: Promise<void> = Promise.resolve();
  let lastSaved = stored ? JSON.stringify(stored) : "";
  // Durable Object storage writes are metered (100k rows/day on Free): write only real changes.
  const persist = () => {
    const snapshot = { ...ledger };
    const text = JSON.stringify(snapshot);
    if (text === lastSaved) return saving;
    lastSaved = text;
    saving = saving.then(() => store.save(snapshot)).catch((error: unknown) => {
      log("LEDGER_SAVE_ERROR", { message: error instanceof Error ? error.message : String(error) });
    });
    return saving;
  };
  await persist();

  let subrequests = 0;
  const countSubrequest = () => { subrequests += 1; };
  const summary = { claimed: 0, completed: 0, failed: 0, leaseLost: 0, rejected: 0 };

  const stopWith = (code: BudgetStop["code"], prebuilt?: BudgetStop): BudgetStop => {
    if (ledger.stop?.code !== code) {
      ledger = { ...ledger, stop: prebuilt ?? budgetStop(code, ledger, now(), limits) };
      log("OLX_CLOUD_PAUSED", { code, message: ledger.stop?.message, browserMs: ledger.browserMs, safeBudgetMs: limits.safeBrowserBudgetMs, dailyLimitMs: limits.dailyBrowserLimitMs, jobsClaimed: ledger.jobsClaimed });
      void persist();
    }
    return ledger.stop as BudgetStop;
  };

  const session = new CloudBrowserSession(deps.provider, {
    now,
    sleep,
    log,
    countSubrequest,
    assertBudget(openSessionStartedAt) {
      if (canScrape(ledger, now(), openSessionStartedAt, limits)) return;
      const stop = hardStop(ledger, now()) ?? stopWith("OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED");
      throw new ControlledOlxFailure(stop.code, stop.message);
    },
    async onSessionOpened(startedAt, sessionId) {
      ledger = { ...ledger, sessions: ledger.sessions + 1, openSession: { startedAt, sessionId } };
      await persist();
    },
    async onSessionClosed(chargedMs) {
      ledger = { ...ledger, browserMs: ledger.browserMs + chargedMs, openSession: null };
      await persist();
    },
    async onDailyLimitRejected() {
      ledger = { ...ledger, browserMs: Math.max(ledger.browserMs, limits.dailyBrowserLimitMs) };
      stopWith("OLX_CLOUD_BROWSER_DAILY_LIMIT_429");
      await persist();
    },
    async onOlxRefused(code) {
      ledger = { ...ledger, refusalStreak: ledger.refusalStreak + 1 };
      if (ledger.refusalStreak >= config.refusalPauseThreshold) stopWith("OLX_CLOUD_OLX_ACCESS_PAUSED", accessPauseStop(ledger, now(), config.refusalPauseMs, code));
      await persist();
    },
    async onOlxAccepted() {
      if (ledger.refusalStreak === 0) return;
      ledger = { ...ledger, refusalStreak: 0 };
      await persist();
    },
  }, { sessionMaxMs: config.sessionMaxMs, keepAliveMs: config.keepAliveMs, blockHeavyResources: config.blockHeavyResources, restrictToOlxDomains: config.restrictToOlxDomains, pageJavaScript: config.pageJavaScript });
  const completeRaw = deps.completeRaw ?? createRawCompleter(config);

  // Every queue call is a subrequest of this invocation, including heartbeats issued by runOlxJob's timer.
  const countedApi: QueueApi = {
    claim: (signal) => { countSubrequest(); return api.claim(signal); },
    heartbeat: (job, signal) => { countSubrequest(); return api.heartbeat(job, signal); },
    complete: (job, result, signal) => {
      countSubrequest();
      const listingsJson = rawListingsJson(result.listings);
      return listingsJson === null ? api.complete(job, result, signal) : completeRaw(job, { ...result, listingsJson }, signal);
    },
    fail: (job, code, message, signal) => { countSubrequest(); return api.fail(job, code, message, signal); },
  };

  // Re-evaluated on every claim, so raising the budget or the job cap takes
  // effect without waiting for midnight. Cloudflare's own 429 is final for the day.
  const pausedCode = (): BudgetStop["code"] | null => {
    const hard = hardStop(ledger, now());
    if (hard) return hard.code;
    if (jobCapReached(ledger, limits)) return "OLX_CLOUD_DAILY_JOB_CAP_REACHED";
    if (!canScrape(ledger, now(), session.openSessionStartedAt(), limits)) return "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED";
    if (ledger.stop) {
      log("OLX_CLOUD_RESUMED", { previousCode: ledger.stop.code, browserMs: ledger.browserMs });
      ledger = { ...ledger, stop: null };
      void persist();
    }
    return null;
  };

  // Paused: report every new job explicitly instead of letting Finder's
  // 90-second watchdog fail it with a generic "worker did not claim" message.
  const initialPause = pausedCode();
  if (initialPause) {
    const stop = hardStop(ledger, now()) ?? stopWith(initialPause);
    // A manual trial never claims while paused: it must not touch other filters' or Radar's jobs.
    if (config.onBudgetExhausted === "fail_jobs" && !options.expectFilterId) {
      // Rejecting costs almost no CPU (no browser, tiny bodies): bounded only by the subrequest allowance.
      const maxRejections = options.maxJobs ?? Number.POSITIVE_INFINITY;
      while (subrequests + 2 <= subrequestLimit && summary.rejected < maxRejections) {
        const { job } = await countedApi.claim();
        if (!job) break;
        await rejectJob(job, stop);
      }
    }
    await saving;
    return { outcome: "paused", ...summary, subrequests, browserLaunches: 0, stop: ledger.stop, ledger };
  }

  const running = new Map<string, Promise<void>>();
  let outcome: BatchOutcome = "idle";
  // An empty queue or a failed claim keeps "worked": new jobs are asked for when a slot frees.
  const stillClaiming = () => outcome === "worked";

  async function rejectJob(job: WorkerJob, stop: BudgetStop) {
    try {
      await countedApi.fail(job, stop.code, stop.message);
      ledger = { ...ledger, jobsRejected: ledger.jobsRejected + 1 };
      summary.rejected += 1;
      log("JOB_REJECTED_BUDGET", { jobId: job.id, code: stop.code, resumesAt: stop.resumesAt });
    } catch {
      log("JOB_FAIL_REPORT_ERROR", { jobId: job.id, code: "OLX_FAIL_REPORT_FAILED" });
    }
    void persist();
  }

  async function rejectForeignJob(job: WorkerJob) {
    const message = `Test Cloudflare (filtr ${options.expectFilterId}) odebrał zadanie spoza testu (${job.contextType === "price_radar" ? "Radar" : `filtr ${job.filterId ?? "?"}`}); zakończono je bez pobierania OLX i bez zapisu ofert. Uruchom ten skan ponownie.`;
    log("JOB_REJECTED_FOREIGN", { jobId: job.id, contextType: job.contextType ?? "finder", filterId: job.filterId });
    try {
      await countedApi.fail(job, "OLX_CLOUD_TEST_FOREIGN_JOB", message);
      summary.rejected += 1;
      ledger = { ...ledger, jobsRejected: ledger.jobsRejected + 1 };
    } catch {
      log("JOB_FAIL_REPORT_ERROR", { jobId: job.id, code: "OLX_FAIL_REPORT_FAILED" });
    }
    void persist();
  }

  const idModeFor = (job: WorkerJob): ListingIdMode =>
    config.listingIdPolicy === "stable_all" || (config.listingIdPolicy === "stable_finder" && job.contextType !== "price_radar") ? "stable" : "legacy";

  const startJob = (job: WorkerJob) => {
    const release = session.hold();
    ledger = { ...ledger, jobsClaimed: ledger.jobsClaimed + 1 };
    void persist();
    const task = runOlxJob({
      job, api: countedApi, scrape: session.scrapeFor(release, { idMode: idModeFor(job) }), shutdownSignal: shutdown.signal, log,
      ...deps.jobTimings,
    }).then((result) => {
      if (result === "completed") { summary.completed += 1; ledger = { ...ledger, jobsCompleted: ledger.jobsCompleted + 1 }; }
      else if (result === "lease_lost") summary.leaseLost += 1;
      else { summary.failed += 1; ledger = { ...ledger, jobsFailed: ledger.jobsFailed + 1 }; }
    }, (error: unknown) => {
      summary.failed += 1;
      log("JOB_RUNNER_ERROR", { jobId: job.id, message: error instanceof Error ? error.message : String(error) });
    }).finally(async () => {
      release();
      running.delete(job.id);
      await session.closeIfIdle();
      void persist();
    });
    running.set(job.id, task);
  };

  const fill = async () => {
    while (running.size < config.maxHeldJobs) {
      if (summary.claimed >= maxJobs) { outcome = "max_jobs"; return; }
      if (now() >= claimDeadline) { outcome = "claim_window"; return; }
      const reserve = SUBREQUESTS_PER_JOB * (running.size + 1) + (session.openSessionStartedAt() === null ? SUBREQUESTS_PER_SESSION : 0);
      if (subrequests + reserve > subrequestLimit) { outcome = "subrequest_limit"; return; }
      const paused = pausedCode();
      if (paused) { if (!hardStop(ledger, now())) stopWith(paused); outcome = "paused"; return; }
      let job: WorkerJob | null;
      try {
        job = (await countedApi.claim()).job;
      } catch (error) {
        log("WORKER_POLL_ERROR", { message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!job) return;
      if (running.has(job.id)) {
        // The queue hands out a job only with a fresh lease; seeing one we already run means a server bug. Never run it twice.
        log("JOB_DUPLICATE_CLAIM_IGNORED", { jobId: job.id });
        continue;
      }
      if (options.expectFilterId && (job.contextType === "price_radar" || job.filterId !== options.expectFilterId)) {
        await rejectForeignJob(job);
        outcome = "foreign_job";
        return;
      }
      summary.claimed += 1;
      outcome = "worked";
      startJob(job);
    }
  };

  try {
    await fill();
    while (running.size > 0) {
      await Promise.race(running.values());
      // A finished job frees a slot; ask the queue again unless we already stopped for a hard reason.
      if (stillClaiming()) await fill();
    }
  } finally {
    await Promise.allSettled(running.values());
    await session.close("batch_end");
    await saving;
  }
  return { outcome, ...summary, subrequests, browserLaunches: session.launches, stop: ledger.stop, ledger };
}

export function budgetLimits(config: CloudConfig): BudgetLimits {
  return {
    dailyBrowserLimitMs: config.dailyBrowserLimitMs,
    safeBrowserBudgetMs: config.safeBrowserBudgetMs,
    scrapeReserveMs: config.scrapeReserveMs,
    sessionMaxMs: config.sessionMaxMs,
    keepAliveMs: config.keepAliveMs,
    maxJobsPerDay: config.maxJobsPerDay,
  };
}

/**
 * Delay until the next Durable Object alarm.
 *
 * Finder fails an OLX job that nobody claimed within 90 s. The alarm (not the
 * one-minute Cron Trigger) drives polling, so the worst-case claim latency of
 * an idle runner is `idlePollMs` plus the alarm's own scheduling delay; with
 * the default 20 s that leaves >60 s of slack. After work we look again almost
 * immediately, because more jobs of the same scan usually follow.
 */
export function nextAlarmDelayMs(summary: Pick<BatchSummary, "outcome" | "stop">, config: Pick<CloudConfig, "idlePollMs" | "onBudgetExhausted">, now: number, idleDelayMs: number = config.idlePollMs): number {
  switch (summary.outcome) {
    case "worked":
    case "subrequest_limit":
    case "claim_window":
    case "max_jobs":
    case "foreign_job":
      return 1_000;
    case "paused": {
      // fail_jobs keeps polling so each new job gets the explicit diagnostic well within 90 s.
      if (config.onBudgetExhausted === "fail_jobs") return idleDelayMs;
      const untilResume = summary.stop ? Date.parse(summary.stop.resumesAt) - now : config.idlePollMs;
      return Math.max(config.idlePollMs, Math.min(untilResume, 15 * 60_000));
    }
    default:
      return idleDelayMs;
  }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
