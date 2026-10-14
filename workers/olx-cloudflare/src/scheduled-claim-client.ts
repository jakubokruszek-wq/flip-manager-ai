import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerJob } from "../../olx-browser/src/api-client.ts";

/** Why the server handed out no job (claim_scheduled_finder_olx_job). */
export type ScheduledClaimReason = "AUTOMATION_DISABLED" | "OLX_JOB_RUNNING" | "DAILY_CLAIM_USED" | "NO_DUE_JOB" | "BROWSER_USAGE_UNKNOWN" | "BROWSER_BUDGET_INSUFFICIENT";
/** Reported with every claim; the database keeps it (olx_cloud_budget) and gates enqueue and claim on it. */
export type ScheduledClaimUsage = { accountBrowserMs: number; workerBrowserMs: number; safeBudgetMs: number; jobEstimateMs: number };
export type ScheduledClaim = { job: WorkerJob | null; reason: ScheduledClaimReason | null };

/**
 * POST /api/olx-worker/claim-scheduled with body `{ workerId, usage }` (same
 * HMAC as /claim). The server decides which automatic Finder job, if any, is
 * due; the Worker has no selector and cannot ask for anything else. `usage` is
 * this Worker's measured Browser Run usage of today.
 */
export function createScheduledClaimer(config: { apiUrl: URL; secret: string; workerId: string }) {
  return async (usage: ScheduledClaimUsage, signal?: AbortSignal): Promise<ScheduledClaim> => {
    const body = JSON.stringify({ workerId: config.workerId, usage });
    const url = new URL("/api/olx-worker/claim-scheduled", config.apiUrl);
    const auth = createWorkerAuthHeaders({ secret: config.secret, method: "POST", pathname: url.pathname, body });
    const response = await fetch(url, {
      method: "POST",
      body,
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp,
        [OLX_WORKER_NONCE_HEADER]: auth.nonce,
        [OLX_WORKER_SIGNATURE_HEADER]: auth.signature,
      },
    });
    const result = await response.json().catch(() => null) as { job?: WorkerJob | null; reason?: string | null; error?: string } | null;
    if (!response.ok) throw new Error(result?.error ? String(result.error) : `WORKER_API_HTTP_${response.status}`);
    return { job: result?.job ?? null, reason: (result?.reason ?? null) as ScheduledClaimReason | null };
  };
}

/** A scheduled claim must return only a Finder job (Radar never runs in this mode). */
export function isScheduledFinderJob(job: WorkerJob): boolean {
  return (job.contextType ?? "finder") === "finder" && !job.radarRunLeaseToken;
}

export type BrowserSessionRecord = { startTime: number; endTime?: number | null };

/**
 * Browser time of the whole Cloudflare account in the current UTC day, from
 * Browser Run's history() (every Worker of the account: stage-2 tests, Radar
 * if it ever runs there). Sessions crossing midnight count from midnight; a
 * session still open counts until now. Used as a second, account-level gate
 * next to this Worker's own ledger.
 */
export function accountBrowserMsToday(sessions: readonly BrowserSessionRecord[], now: number): number {
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let total = 0;
  for (const session of sessions) {
    if (!Number.isFinite(session.startTime)) continue;
    const end = typeof session.endTime === "number" && Number.isFinite(session.endTime) && session.endTime > 0 ? session.endTime : now;
    const start = Math.max(session.startTime, midnight);
    if (end > start) total += end - start;
  }
  return total;
}
