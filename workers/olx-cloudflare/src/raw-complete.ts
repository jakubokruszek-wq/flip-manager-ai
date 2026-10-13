import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerJob } from "../../olx-browser/src/api-client.ts";

export type RawCompletion = { fetched: number; listingsJson: string; warnings: string[]; durationMs: number };

/**
 * POST /api/olx-worker/complete with the listings JSON spliced in as-is.
 * Same body fields, HMAC headers, timeout and error handling as the shared
 * `createApiClient().complete`; only the serialisation differs (no
 * parse/stringify of ~300 kB on the Worker's 10 ms CPU budget).
 */
export function createRawCompleter(config: { apiUrl: URL; secret: string; workerId: string }) {
  return async (job: WorkerJob, result: RawCompletion, signal?: AbortSignal): Promise<unknown> => {
    const body = `{"jobId":${JSON.stringify(job.id)},"leaseToken":${JSON.stringify(job.leaseToken)},"workerId":${JSON.stringify(config.workerId)},`
      + `"radarLeaseToken":${JSON.stringify(job.radarRunLeaseToken ?? null)},"fetched":${nonnegativeInteger(result.fetched)},`
      + `"listings":${result.listingsJson},"warnings":${JSON.stringify(result.warnings)},"durationMs":${nonnegativeInteger(result.durationMs)}}`;
    const url = new URL("/api/olx-worker/complete", config.apiUrl);
    const auth = createWorkerAuthHeaders({ secret: config.secret, method: "POST", pathname: url.pathname, body });
    const response = await fetch(url, {
      method: "POST",
      body,
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      headers: {
        "content-type": "application/json",
        [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp,
        [OLX_WORKER_NONCE_HEADER]: auth.nonce,
        [OLX_WORKER_SIGNATURE_HEADER]: auth.signature,
      },
    });
    const parsed = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : `WORKER_API_HTTP_${response.status}`);
    return parsed;
  };
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
