import { ControlledOlxFailure, withTransientRetry } from "./retry.ts";
import type { WorkerHeartbeat, WorkerJob } from "./api-client.ts";

export const OLX_JOB_WALL_CLOCK_LIMIT_MS = 210_000;
export const OLX_JOB_FINALIZATION_LIMIT_MS = 85_000;
export const OLX_JOB_HEARTBEAT_INTERVAL_MS = 30_000;

type OlxResult = Awaited<ReturnType<(url: string, signal: AbortSignal) => Promise<{
  diagnostics: { status: number | null; finalUrl: string; title: string; bodyLength: number; marker: boolean };
  rawItems: number;
  normalizedItems: number;
  listings: unknown[];
  warnings: string[];
  durationMs: number;
}>>>;

type WorkerApi = {
  heartbeat(job: WorkerJob, signal?: AbortSignal): Promise<WorkerHeartbeat>;
  complete(job: WorkerJob, result: { fetched: number; listings: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal): Promise<unknown>;
  fail(job: WorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal): Promise<unknown>;
};

type RunnerOptions = {
  job: WorkerJob;
  api: WorkerApi;
  scrape(url: string, signal: AbortSignal): Promise<OlxResult>;
  shutdownSignal: AbortSignal;
  log(event: string, data: Record<string, unknown>): void;
  heartbeatIntervalMs?: number;
  wallClockLimitMs?: number;
  finalizationLimitMs?: number;
};

/** Executes one already-claimed queue job. Lease tokens are sent only to API methods and never logged. */
export async function runOlxJob(options: RunnerOptions): Promise<"completed" | "failed" | "lease_lost" | "shutdown"> {
  const { job, api, scrape, shutdownSignal, log } = options;
  const durationMs = options.wallClockLimitMs ?? OLX_JOB_WALL_CLOCK_LIMIT_MS;
  const heartbeatMs = options.heartbeatIntervalMs ?? OLX_JOB_HEARTBEAT_INTERVAL_MS;
  const finalizationLimitMs = Math.min(options.finalizationLimitMs ?? OLX_JOB_FINALIZATION_LIMIT_MS, durationMs);
  const workLimitMs = Math.max(1, durationMs - finalizationLimitMs);
  const timeout = new AbortController();
  const leaseLoss = new AbortController();
  const signal = AbortSignal.any([shutdownSignal, timeout.signal, leaseLoss.signal]);
  let timedOut = false;
  let leaseLost = false;
  let finalizing = false;
  let heartbeatInFlight: Promise<void> | null = null;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    timeout.abort(new Error("OLX_JOB_DURATION_LIMIT"));
  }, workLimitMs);

  const heartbeat = (): Promise<void> => {
    if (heartbeatInFlight) return heartbeatInFlight;
    if (signal.aborted) return Promise.resolve();
    heartbeatInFlight = (async () => {
      try {
        const leases = await api.heartbeat(job, signal);
        if (!isTimestamp(leases.jobLeasedUntil) || !isFuture(leases.jobLeasedUntil)) throw new Error("OLX_JOB_LEASE_NOT_ACTIVE");
        if (job.contextType === "price_radar") {
          if (!leases.radarLeaseUntil || !isTimestamp(leases.radarLeaseUntil) || !isFuture(leases.radarLeaseUntil)) throw new Error("RADAR_LEASE_NOT_ACTIVE");
        } else if (leases.radarLeaseUntil !== null) {
          throw new Error("OLX_HEARTBEAT_RESPONSE_INVALID");
        }
        log("JOB_HEARTBEAT", { jobId: job.id, jobLeasedUntil: leases.jobLeasedUntil, radarLeaseUntil: leases.radarLeaseUntil });
      } catch {
        // The wall-clock deadline intentionally aborts an in-flight heartbeat
        // along with the scrape. That does not revoke the last confirmed
        // lease: try to record the timeout while that lease is still valid.
        if (timedOut) {
          log("JOB_HEARTBEAT_ABORTED_BY_JOB_DEADLINE", { jobId: job.id, code: "OLX_JOB_DURATION_LIMIT" });
          return;
        }
        leaseLost = true;
        log("JOB_HEARTBEAT_ERROR", { jobId: job.id, code: "OLX_LEASE_HEARTBEAT_FAILED" });
        leaseLoss.abort(new Error("OLX_LEASE_HEARTBEAT_FAILED"));
      } finally {
        heartbeatInFlight = null;
      }
    })();
    return heartbeatInFlight;
  };

  const heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
  log("JOB_START", {
    jobId: job.id, runId: job.runId, attempt: job.attempts, contextType: job.contextType ?? "finder",
    jobLeasedUntil: job.leasedUntil, radarLeaseUntil: job.radarLeaseUntil ?? null,
  });

  try {
    // Validate both queue ownership and (for Radar jobs) the separate run
    // lease before opening the browser. Claim output alone is not a heartbeat.
    await heartbeat();
    signal.throwIfAborted();
    const result = await withTransientRetry((attempt) => {
      signal.throwIfAborted();
      log("OLX_BROWSER_START", { jobId: job.id, attempt });
      return scrape(job.requestUrl, signal);
    }, 1, signal);
    signal.throwIfAborted();
    log("OLX_BROWSER_DONE", { jobId: job.id, status: result.diagnostics.status, finalUrl: result.diagnostics.finalUrl, title: result.diagnostics.title, bodyLength: result.diagnostics.bodyLength, marker: result.diagnostics.marker, rawItems: result.rawItems, normalizedItems: result.normalizedItems, durationMs: result.durationMs });

    // Renew both relevant leases immediately before finalization, then stop the
    // timer. The existing completion request has a 90-second timeout; a fresh
    // 120-second lease leaves room without racing a heartbeat against the
    // terminal complete/fail transaction.
    await heartbeat();
    signal.throwIfAborted();
    clearInterval(heartbeatTimer);
    clearTimeout(deadlineTimer);
    finalizing = true;
    await api.complete(job, { fetched: result.rawItems, listings: result.listings, warnings: result.warnings, durationMs: result.durationMs }, finalizationSignal(shutdownSignal, finalizationLimitMs));
    log("JOB_COMPLETE", { jobId: job.id, rawItems: result.rawItems, normalizedItems: result.normalizedItems });
    return "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : "OLX_WORKER_ERROR";
    const code = leaseLost ? "OLX_JOB_LEASE_LOST"
      : timedOut ? "OLX_JOB_DURATION_LIMIT"
      : error instanceof ControlledOlxFailure ? error.code
      : shutdownSignal.aborted ? "WORKER_SHUTDOWN" : "OLX_WORKER_ERROR";
    log("JOB_ERROR", { jobId: job.id, code, message: redactLeaseTokens(message) });
    if (leaseLost) return "lease_lost";
    if (shutdownSignal.aborted) return "shutdown";
    if (finalizing) return "failed";
    try {
      await api.fail(job, code, redactLeaseTokens(message).slice(0, 1000), finalizationSignal(shutdownSignal, finalizationLimitMs));
      log("JOB_FAIL", { jobId: job.id, code });
    } catch {
      log("JOB_FAIL_REPORT_ERROR", { jobId: job.id, code: "OLX_FAIL_REPORT_FAILED" });
    }
    return "failed";
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(deadlineTimer);
  }
}

function finalizationSignal(shutdownSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([shutdownSignal, AbortSignal.timeout(timeoutMs)]);
}

function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isFuture(value: string): boolean { return Date.parse(value) > Date.now(); }
function redactLeaseTokens(value: string): string {
  return value.replace(/(?:radar)?lease\s*token\s*[:=]\s*[^\s,;]+/giu, "leaseToken=[redacted]");
}
