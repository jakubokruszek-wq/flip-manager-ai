import { AndroidJobError, claimAndroidJob, completeAndroidJob, heartbeatAndroidJob, readAndroidJobStatus, type AndroidJobStore } from "./jobs.ts";
import type { FacebookCollectorBatch } from "../facebook-batch.ts";

export const ANDROID_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export type AndroidAction = "claim" | "heartbeat" | "complete" | "status";
export type AndroidDependencies = {
  enabled: () => boolean;
  expectedDataMode?: "LIVE" | "OFFLINE_TEST";
  authenticate: (request: Request, pathname: string, body: string) => Promise<string>;
  store: () => AndroidJobStore;
  processBatch: (deviceId: string, batch: FacebookCollectorBatch, context: { sourceScanId: string }) => Promise<{ status: string }>;
};
export async function handleAndroidRequest(request: Request, action: AndroidAction, deps: AndroidDependencies): Promise<Response> {
  try {
    if (request.method !== "POST") throw new AndroidJobError(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AndroidJobError(415, "JSON_REQUIRED");
    const body = await readLimitedBody(request);
    const deviceId = await deps.authenticate(request, `/api/collector/android/jobs/${action}`, body);
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new AndroidJobError(400, "INVALID_PAYLOAD"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AndroidJobError(400, "INVALID_PAYLOAD");
    // Drain/renew already leased work even after claims have been disabled.
    if (action === "claim" && !deps.enabled()) return json({ ok: true, job: null, code: "ANDROID_QUEUE_DISABLED" });
    const store = deps.store();
    if (action === "claim") {
      const job = await claimAndroidJob(store, deviceId, value);
      return json({ ok: true, job, code: job ? "JOB_CLAIMED" : "NO_PENDING_JOB" });
    }
    if (action === "status") return json(await readAndroidJobStatus(store, deviceId, value));
    if (action === "heartbeat") return json({ ok: true, leasedUntil: await heartbeatAndroidJob(store, deviceId, value) });
    return json(await completeAndroidJob({ store, deviceId, value, rawBody: body, processBatch: deps.processBatch, expectedDataMode: deps.expectedDataMode }));
  } catch (error) {
    const known = error instanceof AndroidJobError;
    const code = known ? error.code : "ANDROID_REQUEST_FAILED";
    const status = known ? error.status : 503;
    const retryable = status === 503 || code === "ANDROID_COMPLETION_IN_PROGRESS";
    const response = json({ ok: false, code, retryable, retryAfterSeconds: retryable ? 15 : null }, status);
    if (retryable) response.headers.set("Retry-After", "15");
    return response;
  }
}
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
async function readLimitedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > ANDROID_BODY_LIMIT_BYTES) throw new AndroidJobError(413, "PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ANDROID_BODY_LIMIT_BYTES) { await reader.cancel(); throw new AndroidJobError(413, "PAYLOAD_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
