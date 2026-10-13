import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerJob } from "../../olx-browser/src/api-client.ts";

/** Exactly one of the two: the trial claims a named job or the oldest queued job of one filter. */
export type ClaimSelector = { jobId: string } | { filterId: string };

/**
 * POST /api/olx-worker/claim-selective — same HMAC headers as the regular
 * claim. The server claims only a queued Finder job matching the selector
 * (claim_olx_scan_job_selective); no other job is read for update or changed.
 * The regular /claim is never used by the manual trial.
 */
export function createSelectiveClaimer(config: { apiUrl: URL; secret: string; workerId: string }) {
  return async (selector: ClaimSelector, signal?: AbortSignal): Promise<{ job: WorkerJob | null }> => {
    const body = JSON.stringify({ workerId: config.workerId, ...selector });
    const url = new URL("/api/olx-worker/claim-selective", config.apiUrl);
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
    const result = await response.json().catch(() => null) as { job?: WorkerJob | null; error?: string } | null;
    if (!response.ok) throw new Error(result?.error ? String(result.error) : `WORKER_API_HTTP_${response.status}`);
    return { job: result?.job ?? null };
  };
}

export function selectorMatches(selector: ClaimSelector, job: WorkerJob): boolean {
  if ((job.contextType ?? "finder") !== "finder") return false;
  return "jobId" in selector ? job.id === selector.jobId : job.filterId === selector.filterId;
}
