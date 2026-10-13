import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerJob } from "../../olx-browser/src/api-client.ts";

/** The controlled test claims exactly one job, named by id. There is no filter or "oldest job" selector. */
export type ClaimSelector = { jobId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * POST /api/olx-worker/claim-selective — same HMAC headers as the regular
 * claim. The server claims only the queued Finder job with this id
 * (claim_olx_scan_job_selective); no other job is read for update or changed.
 * The regular /claim is never used by the manual test.
 */
export function createSelectiveClaimer(config: { apiUrl: URL; secret: string; workerId: string }) {
  return async (selector: ClaimSelector, signal?: AbortSignal): Promise<{ job: WorkerJob | null }> => {
    if (!isJobId(selector.jobId)) throw new Error("OLX_CLOUD_JOB_ID_INVALID");
    const body = JSON.stringify({ workerId: config.workerId, jobId: selector.jobId });
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
  return (job.contextType ?? "finder") === "finder" && job.id === selector.jobId;
}
