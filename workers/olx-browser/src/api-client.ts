import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerConfig } from "./config.ts";

export type WorkerJob = { id: string; runId: string; sourceScanId: string; filterId: string; requestUrl: string; leaseToken: string; leasedUntil: string; attempts: number };

export function createApiClient(config: WorkerConfig) {
  async function post<T>(pathname: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify(payload);
    const url = new URL(pathname, config.apiUrl);
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
    const result = await response.json().catch(() => null) as T | { error?: string } | null;
    if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result ? String(result.error) : `WORKER_API_HTTP_${response.status}`);
    return result as T;
  }
  return {
    claim: (signal?: AbortSignal) => post<{ job: WorkerJob | null }>("/api/olx-worker/claim", { workerId: config.workerId }, signal),
    heartbeat: (job: WorkerJob, signal?: AbortSignal) => post("/api/olx-worker/heartbeat", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId }, signal),
    complete: (job: WorkerJob, result: { fetched: number; listings: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal) => post("/api/olx-worker/complete", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, ...result }, signal),
    fail: (job: WorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal) => post("/api/olx-worker/fail", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, errorCode, errorMessage }, signal),
  };
}
