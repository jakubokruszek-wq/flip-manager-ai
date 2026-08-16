import { createFacebookWorkerAuthHeaders, FACEBOOK_WORKER_NONCE_HEADER, FACEBOOK_WORKER_SIGNATURE_HEADER, FACEBOOK_WORKER_TIMESTAMP_HEADER } from "../../../features/facebook-worker/protocol.ts";
import type { FacebookVisionExtraction, FacebookWorkerJob } from "../../../features/facebook-worker/types.ts";
import type { FacebookWorkerConfig } from "./config.ts";

export function createFacebookApiClient(config: FacebookWorkerConfig) {
  async function post<T>(pathname: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify(payload); const url = new URL(pathname, config.apiUrl);
    const auth = createFacebookWorkerAuthHeaders({ secret: config.secret, method: "POST", pathname: url.pathname, body });
    const response = await fetch(url, { method: "POST", body, cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), headers: { "content-type": "application/json", [FACEBOOK_WORKER_TIMESTAMP_HEADER]: auth.timestamp, [FACEBOOK_WORKER_NONCE_HEADER]: auth.nonce, [FACEBOOK_WORKER_SIGNATURE_HEADER]: auth.signature } });
    const result = await response.json().catch(() => null) as T | { error?: string } | null;
    if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result ? String(result.error) : `FACEBOOK_WORKER_API_HTTP_${response.status}`);
    return result as T;
  }
  return {
    claim: (signal?: AbortSignal) => post<{ job: FacebookWorkerJob | null }>("/api/facebook-worker/claim", { workerId: config.workerId }, signal),
    heartbeat: (job: FacebookWorkerJob, signal?: AbortSignal) => post("/api/facebook-worker/heartbeat", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId }, signal),
    vision: (job: FacebookWorkerJob, input: { postId: string; screenshotDataUrl: string }, signal?: AbortSignal) => post<{ vision: FacebookVisionExtraction }>("/api/facebook-worker/vision", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, ...input }, signal),
    complete: (job: FacebookWorkerJob, result: { posts: unknown[]; warnings: string[]; durationMs: number }, signal?: AbortSignal) => post("/api/facebook-worker/complete", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, ...result }, signal),
    fail: (job: FacebookWorkerJob, errorCode: string, errorMessage: string, signal?: AbortSignal) => post("/api/facebook-worker/fail", { jobId: job.id, leaseToken: job.leaseToken, workerId: config.workerId, errorCode, errorMessage }, signal),
  };
}
