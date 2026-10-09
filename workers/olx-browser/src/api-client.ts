import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import type { WorkerConfig } from "./config.ts";

export type WorkerJob = { id: string; runId: string; sourceScanId: string | null; filterId: string | null; contextType?: "finder" | "price_radar"; radarOwnerId?: string | null; radarRunLeaseToken?: string | null; radarLeaseUntil?: string | null; requestUrl: string; leaseToken: string; leasedUntil: string; attempts: number };
export type WorkerHeartbeat = { jobLeasedUntil: string; radarLeaseUntil: string | null };

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
  async function heartbeat(job: WorkerJob, signal?: AbortSignal): Promise<WorkerHeartbeat> {
    const result = await post<{ ok: boolean; jobLeasedUntil: unknown; radarLeaseUntil: unknown }>("/api/olx-worker/heartbeat", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, radarLeaseToken: job.radarRunLeaseToken ?? null }, signal);
    if (!result || result.ok !== true || typeof result.jobLeasedUntil !== "string" || !Number.isFinite(Date.parse(result.jobLeasedUntil))) throw new Error("OLX_HEARTBEAT_RESPONSE_INVALID");
    if (job.contextType === "price_radar") {
      if (typeof result.radarLeaseUntil !== "string" || !Number.isFinite(Date.parse(result.radarLeaseUntil))) throw new Error("RADAR_HEARTBEAT_RESPONSE_INVALID");
      return { jobLeasedUntil: result.jobLeasedUntil, radarLeaseUntil: result.radarLeaseUntil };
    }
    if (result.radarLeaseUntil !== null) throw new Error("OLX_HEARTBEAT_RESPONSE_INVALID");
    return { jobLeasedUntil: result.jobLeasedUntil, radarLeaseUntil: null };
  }
  return {
    claim: (signal?: AbortSignal) => post<{ job: WorkerJob | null }>("/api/olx-worker/claim", { workerId: config.workerId }, signal),
    heartbeat,
    complete: (job: WorkerJob, result: { fetched: number; listings: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal) => post("/api/olx-worker/complete", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, radarLeaseToken: job.radarRunLeaseToken ?? null, ...result }, signal),
    fail: (job: WorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal) => post("/api/olx-worker/fail", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, radarLeaseToken: job.radarRunLeaseToken ?? null, errorCode, errorMessage }, signal),
  };
}
