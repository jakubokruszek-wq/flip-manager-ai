import { createIdlePollBackoff } from "../../shared/idle-poll-backoff.ts";
import { createOlxAccessGuard, OLX_ACCESS_DENIED_CODES } from "./access-guard.ts";
import type { WorkerJob, WorkerHeartbeat } from "./api-client.ts";
import type { WorkerConfig } from "./config.ts";
import { OLX_JOB_WALL_CLOCK_LIMIT_MS, runOlxJob } from "./job-runner.ts";
import type { WorkerMonitor } from "./monitor.ts";
import type { StallWatchdog } from "./watchdog.ts";

/** api-client.ts aborts every request after 90 s; the watchdog allows a margin on top. */
const CLAIM_BUDGET_MS = 90_000 + 30_000;
/** Wall clock covers work + complete; a failed job may additionally spend one fail report. */
const JOB_BUDGET_MS = OLX_JOB_WALL_CLOCK_LIMIT_MS + 90_000;
const SLEEP_MARGIN_MS = 30_000;

type WorkerApi = {
  claim(signal?: AbortSignal): Promise<{ job: WorkerJob | null }>;
  heartbeat(job: WorkerJob, signal?: AbortSignal): Promise<WorkerHeartbeat>;
  complete(job: WorkerJob, result: { fetched: number; listings: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal): Promise<unknown>;
  fail(job: WorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal): Promise<unknown>;
};

export type WorkerDependencies = {
  config: Pick<WorkerConfig, "workerId" | "pollIntervalMs" | "once" | "blockCooldownMs" | "maxBlockCooldownMs">;
  api: WorkerApi;
  scrape: Parameters<typeof runOlxJob>[0]["scrape"];
  log(event: string, data?: Record<string, unknown>): void;
  shutdownSignal: AbortSignal;
  monitor: WorkerMonitor;
  watchdog?: Pick<StallWatchdog, "arm" | "disarm">;
  /** Test overrides for the job runner's timing. */
  jobTiming?: { heartbeatIntervalMs?: number; wallClockLimitMs?: number; finalizationLimitMs?: number };
};

/**
 * Long-running outbound loop: claim one job from the existing Supabase-backed
 * queue (via the HMAC-authenticated Flip Manager API), run it, repeat. It
 * never creates jobs or Radar runs; the Finder and Radar modules enqueue them.
 */
export async function runWorker(deps: WorkerDependencies): Promise<void> {
  const { config, api, log, shutdownSignal, monitor } = deps;
  const pollBackoff = createIdlePollBackoff(config.pollIntervalMs);
  const accessGuard = createOlxAccessGuard({ baseCooldownMs: config.blockCooldownMs, maxCooldownMs: config.maxBlockCooldownMs });
  const watchdog = deps.watchdog ?? { arm: () => undefined, disarm: () => undefined };

  log("WORKER_START", { workerId: config.workerId, once: config.once, pollIntervalMs: config.pollIntervalMs, blockCooldownMs: config.blockCooldownMs });
  let accessDeniedCode: string | null = null;
  while (!shutdownSignal.aborted) {
    const cooling = accessGuard.remainingMs() > 0;
    monitor.setState(cooling ? "cooldown" : "polling");
    watchdog.arm("claim", CLAIM_BUDGET_MS);
    let job: WorkerJob | null = null;
    try {
      ({ job } = await api.claim(shutdownSignal));
      monitor.recordPoll(job);
      if (job) pollBackoff.recordClaimWithJob();
      else pollBackoff.recordEmptyClaim();
    } catch (error) {
      if (shutdownSignal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      pollBackoff.recordRequestError();
      monitor.recordPollError(message);
      log("WORKER_POLL_ERROR", { message, nextPollMs: pollBackoff.currentDelayMs() });
    }

    if (job && accessGuard.remainingMs() > 0) {
      // OLX refused access recently. Do not open OLX at all; release the job at
      // once with an explicit reason instead of letting the Finder/Radar
      // watchdogs time it out as "worker did not claim".
      watchdog.arm("cooldown_release", CLAIM_BUDGET_MS);
      await releaseDuringCooldown(job, accessDeniedCode ?? "OLX_ACCESS_DENIED", new Date(Date.now() + accessGuard.remainingMs()).toISOString());
    } else if (job) {
      monitor.setState("running_job");
      watchdog.arm("job", JOB_BUDGET_MS);
      await runOlxJob({
        job, api, scrape: deps.scrape, shutdownSignal, log: (event, data) => log(event, data),
        ...deps.jobTiming,
        onFinished: (summary) => {
          const accessDenied = summary.code !== null && OLX_ACCESS_DENIED_CODES.has(summary.code);
          const last = monitor.recordJob(summary, accessDenied);
          log("JOB_SUMMARY", { ...last });
          const cooldown = accessGuard.record(summary);
          if (cooldown) {
            accessDeniedCode = cooldown.reason;
            monitor.setState("cooldown", { cooldownUntil: cooldown.until });
            log("WORKER_OLX_ACCESS_COOLDOWN", { ...cooldown, lastJobId: summary.jobId });
          }
        },
      });
    }

    if (config.once) break;
    // After a job this is the base interval (a claim resets the backoff), which
    // also spaces consecutive OLX page loads; idle polls back off to 60 s. The
    // Finder fails jobs nobody claims within 90 s, so the cap stays below that.
    if (accessGuard.remainingMs() <= 0) monitor.setState("idle");
    const delayMs = pollBackoff.currentDelayMs();
    watchdog.arm("idle_sleep", delayMs + SLEEP_MARGIN_MS);
    await sleep(delayMs, shutdownSignal);
  }
  watchdog.disarm();
  monitor.setState("stopping");
  log("WORKER_STOP", { workerId: config.workerId, ...monitor.snapshot().totals });

  async function releaseDuringCooldown(job: WorkerJob, reason: string, until: string): Promise<void> {
    const message = `OLX odmówił dostępu (${reason}); worker wstrzymał pobieranie OLX do ${until}. Strona OLX nie była otwierana.`;
    try {
      await api.fail(job, "OLX_ACCESS_COOLDOWN", message, AbortSignal.any([shutdownSignal, AbortSignal.timeout(90_000)]));
      log("JOB_RELEASED_DURING_COOLDOWN", { jobId: job.id, reason, cooldownUntil: until });
    } catch {
      log("JOB_FAIL_REPORT_ERROR", { jobId: job.id, code: "OLX_ACCESS_COOLDOWN" });
    }
    const last = monitor.recordJob({ jobId: job.id, outcome: "failed", code: "OLX_ACCESS_COOLDOWN", rawItems: null, normalizedItems: null, durationMs: 0 }, false);
    log("JOB_SUMMARY", { ...last });
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
