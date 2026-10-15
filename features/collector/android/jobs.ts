import { createHash } from "node:crypto";
import { normalizeFacebookCollectorBatch, type FacebookCollectorBatch } from "../facebook-batch.ts";
import { normalizeFacebookSourceUrl } from "../facebook-production.ts";

export const ANDROID_CONSUMER = "ANDROID_WEBVIEW";
export const ANDROID_LEASE_SECONDS = 180;
export type AndroidJobRow = {
  id: string; scan_run_id: string; source_scan_id: string; search_filter_id: string;
  group_snapshot: unknown; consumer_type: string; job_type: string; status: string;
  lease_token: string; leased_until: string | null; worker_id: string; attempts: number;
  max_attempts?: number; available_at?: string;
  android_completion_state?: "processing" | "settled" | null;
  android_completion_started_at?: string | null;
  android_receipt?: AndroidReceipt | null;
};
export type AndroidReceipt = { ok: true; status: "completed" | "failed"; completionId: string; result: unknown };
export type AndroidRpcResult = { data: unknown; error: unknown };
export type AndroidJobStore = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<AndroidRpcResult>;
  loadJob: (id: string) => Promise<AndroidJobRow | null>;
  loadCompletedBatch?: (binding: { deviceId: string; batchId: string; runId: string; sourceScanId: string; sourceId: string; sourceUrl: string }) => Promise<{ status: string } | null>;
};
export class AndroidJobError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function androidLeaseInput(value: unknown): { jobId: string; leaseToken: string } {
  const input = record(value);
  return { jobId: uuid(input?.jobId), leaseToken: uuid(input?.leaseToken) };
}
export function androidJobContract(job: AndroidJobRow) {
  const group = Array.isArray(job.group_snapshot) && job.group_snapshot.length === 1 ? record(job.group_snapshot[0]) : null;
  const source = group && typeof group.url === "string" ? normalizeFacebookSourceUrl(group.url, group.type === "PROFILE" ? "PROFILE" : "GROUP") : null;
  if (!source || !group || typeof group.id !== "string" || typeof group.name !== "string" ||
      ![job.id, job.scan_run_id, job.source_scan_id, job.search_filter_id, job.lease_token].every(value => typeof value === "string" && value.length > 0) || job.consumer_type !== ANDROID_CONSUMER || job.job_type !== "SOURCE_SCAN") throw new AndroidJobError(503, "ANDROID_JOB_INVALID");
  return {
    id: job.id, runId: job.scan_run_id, sourceScanId: job.source_scan_id, filterId: job.search_filter_id,
    consumerType: ANDROID_CONSUMER, jobType: "SOURCE_SCAN", imageMode: "SOURCE_SCAN_DATA_ONLY",
    group: { id: group.id, name: group.name, ...source }, leaseToken: job.lease_token,
    leasedUntil: job.leased_until, attempts: job.attempts, heartbeatIntervalSeconds: 45,
  };
}
export async function claimAndroidJob(store: AndroidJobStore, deviceId: string, value: unknown = {}) {
  const selection = record(value)?.sourceIds;
  if (selection !== undefined && (!Array.isArray(selection) || selection.length > 50)) throw new AndroidJobError(400, "INVALID_PAYLOAD");
  const sourceIds = selection === undefined ? undefined : [...new Set((selection as unknown[]).map(uuid))];
  const data = await rpc(store, "claim_android_facebook_scan_job", { p_device_id: deviceId, p_lease_seconds: ANDROID_LEASE_SECONDS,
    ...(sourceIds === undefined ? {} : { p_source_ids: sourceIds }) });
  const row = Array.isArray(data) ? data[0] : data;
  if (row && (typeof (row as AndroidJobRow).leased_until !== "string" || !Number.isFinite(Date.parse((row as AndroidJobRow).leased_until!)))) throw new AndroidJobError(503, "ANDROID_JOB_INVALID");
  return row ? androidJobContract(row as AndroidJobRow) : null;
}
export async function heartbeatAndroidJob(store: AndroidJobStore, deviceId: string, value: unknown) {
  const { jobId, leaseToken } = androidLeaseInput(value);
  const data = await rpc(store, "renew_android_facebook_scan_job", { p_job_id: jobId, p_device_id: deviceId, p_lease_token: leaseToken, p_lease_seconds: ANDROID_LEASE_SECONDS });
  const row = record(Array.isArray(data) ? data[0] : data);
  if (typeof row?.leased_until !== "string") throw new AndroidJobError(409, "ANDROID_JOB_LEASE_LOST");
  return row.leased_until;
}
export async function completeAndroidJob(input: {
  store: AndroidJobStore; deviceId: string; value: unknown; rawBody: string;
  expectedDataMode?: "LIVE" | "OFFLINE_TEST";
  /** Internal opt-in for the isolated adapter with atomic import+checkpoint only. */
  atomicOfflineImportReplay?: boolean;
  processBatch: (deviceId: string, batch: FacebookCollectorBatch, context: { sourceScanId: string }) => Promise<{ status: string }>;
}): Promise<AndroidReceipt> {
  const { jobId, leaseToken } = androidLeaseInput(input.value);
  const value = record(input.value)!;
  const completionId = uuid(value.completionId);
  if (value.dataMode !== (input.expectedDataMode ?? "LIVE")) throw new AndroidJobError(422, "ANDROID_DATA_DOMAIN_MISMATCH");
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") throw new AndroidJobError(400, "INVALID_PAYLOAD");
  const failed = value.status !== "completed";
  const errorCode = value.status === "cancelled" ? "ANDROID_CANCELLED" : value.errorCode;
  const failureResult = value.status === "cancelled" ? { cancelled: true } : null;
  if (failed && (value.batch !== undefined || typeof errorCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(errorCode))) throw new AndroidJobError(400, "INVALID_PAYLOAD");
  const job = await input.store.loadJob(jobId);
  if (!job || job.consumer_type !== ANDROID_CONSUMER || job.job_type !== "SOURCE_SCAN" || job.worker_id !== input.deviceId || job.lease_token !== leaseToken) throw new AndroidJobError(409, "ANDROID_JOB_LEASE_LOST");
  let batch: FacebookCollectorBatch | null = null;
  if (value.status === "completed") {
    const rawBatch = record(value.batch);
    if (!rawBatch || !Array.isArray(rawBatch.posts) || rawBatch.posts.length > 150 || rawBatch.imageMode !== "SOURCE_SCAN_DATA_ONLY") throw new AndroidJobError(400, "INVALID_PAYLOAD");
    try { batch = normalizeFacebookCollectorBatch(rawBatch); }
    catch { throw new AndroidJobError(422, "ANDROID_BATCH_INVALID"); }
    batch.scanId = batch.scanId.toLowerCase(); batch.batchId = batch.batchId.toLowerCase();
    const source = androidJobContract(job).group;
    if (batch.scanId !== job.scan_run_id || batch.sourceId !== source.sourceId || batch.sourceType !== source.type || batch.sourceUrl !== source.url || batch.batchId !== completionId) throw new AndroidJobError(422, "ANDROID_BATCH_JOB_MISMATCH");
  }
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const args = { p_job_id: jobId, p_device_id: input.deviceId, p_lease_token: leaseToken, p_completion_id: completionId, p_payload_hash: payloadHash };
  const reservation = record(await rpc(input.store, "begin_android_facebook_completion", args));
  if (reservation?.outcome === "duplicate") return validateReceipt(reservation.receipt, completionId);
  if (reservation?.outcome === "busy") {
    // A finished batch is a durable checkpoint. Resume ONLY finalization, never
    // the listing import. Incomplete/ambiguous writes remain fenced.
    if (failed) return finishReceipt(input.store, args, { ok: true, completionId, status: "failed", result: failureResult }, String(errorCode));
    let saved = batch && input.store.loadCompletedBatch ? await input.store.loadCompletedBatch({
      deviceId: input.deviceId, batchId: completionId, runId: job.scan_run_id,
      sourceScanId: job.source_scan_id, sourceId: batch.sourceId, sourceUrl: batch.sourceUrl,
    }) : null;
    if (!saved && batch && input.atomicOfflineImportReplay === true && input.expectedDataMode === "OFFLINE_TEST") {
      // The fixture adapter serializes by batch ID and commits every listing,
      // exact counters and its checkpoint in ONE transaction. Production import
      // cannot opt into this recovery path, even if a caller sets the flag.
      saved = await input.processBatch(input.deviceId, batch, { sourceScanId: job.source_scan_id });
    }
    if (!saved) throw new AndroidJobError(409, "ANDROID_COMPLETION_IN_PROGRESS");
    if (!["completed", "degraded", "failed"].includes(saved.status)) throw new AndroidJobError(503, "ANDROID_PROCESSING_RESULT_INVALID");
    return finishReceipt(input.store, args, { ok: true, completionId, status: saved.status === "failed" ? "failed" : "completed", result: saved }, saved.status === "failed" ? "ANDROID_BATCH_FAILED" : null);
  }
  if (reservation?.outcome === "conflict") throw new AndroidJobError(409, "ANDROID_COMPLETION_CONFLICT");
  if (reservation?.outcome !== "reserved") throw new AndroidJobError(409, "ANDROID_JOB_LEASE_LOST");
  // Reservation is deliberately never cleared on failure: side effects may have
  // committed. An operator must reconcile a stuck import before authorizing a retry.
  const result = batch ? await input.processBatch(input.deviceId, batch, { sourceScanId: job.source_scan_id }) : null;
  if (result?.status === "duplicate") throw new AndroidJobError(409, "ANDROID_BATCH_REQUIRES_RECONCILIATION");
  if (result && !["completed", "degraded", "failed"].includes(result.status)) throw new AndroidJobError(503, "ANDROID_PROCESSING_RESULT_INVALID");
  const receipt: AndroidReceipt = { ok: true, completionId, status: failed || result?.status === "failed" ? "failed" : "completed", result: result ?? failureResult };
  return finishReceipt(input.store, args, receipt, receipt.status === "failed" ? String(errorCode ?? "ANDROID_BATCH_FAILED") : null);
}
async function finishReceipt(store: AndroidJobStore, args: Record<string, unknown>, receipt: AndroidReceipt, errorCode: string | null): Promise<AndroidReceipt> {
  const saved = record(await rpc(store, "finish_android_facebook_completion", { ...args, p_receipt: receipt, p_error_code: errorCode }));
  if (!saved || saved.ok !== true || saved.completionId !== receipt.completionId || !["completed", "failed"].includes(String(saved.status))) throw new AndroidJobError(409, "ANDROID_COMPLETION_REQUIRES_RECONCILIATION");
  return validateReceipt(saved, receipt.completionId);
}
export async function readAndroidJobStatus(store: AndroidJobStore, deviceId: string, value: unknown, now = Date.now()) {
  const { jobId, leaseToken } = androidLeaseInput(value);
  const job = await store.loadJob(jobId);
  if (!job || job.consumer_type !== ANDROID_CONSUMER || job.job_type !== "SOURCE_SCAN" || job.worker_id !== deviceId || job.lease_token !== leaseToken) throw new AndroidJobError(409, "ANDROID_JOB_LEASE_LOST");
  const started = Date.parse(job.android_completion_started_at ?? "");
  const completionState = job.android_completion_state === "settled" ? "SETTLED" : job.android_completion_state === "processing"
    ? (!Number.isFinite(started) || now - started > 5 * 60_000 ? "RECONCILIATION_REQUIRED" : "PROCESSING") : "NONE";
  return { ok: true, jobId, status: job.status, completionState, leasedUntil: job.leased_until,
    receipt: completionState === "SETTLED" ? validateReceipt(job.android_receipt) : null,
    retryAfterSeconds: completionState === "PROCESSING" ? 15 : null };
}
function validateReceipt(value: unknown, completionId?: string): AndroidReceipt {
  const row = record(value);
  if (!row || row.ok !== true || typeof row.completionId !== "string" || (completionId !== undefined && row.completionId !== completionId)
    || !["completed", "failed"].includes(String(row.status)) || !Object.prototype.hasOwnProperty.call(row, "result")) throw new AndroidJobError(503, "ANDROID_RECEIPT_INVALID");
  return row as AndroidReceipt;
}
async function rpc(store: AndroidJobStore, name: string, args: Record<string, unknown>) {
  const result = await store.rpc(name, args);
  if (result.error) throw new AndroidJobError(503, "ANDROID_QUEUE_UNAVAILABLE");
  return result.data;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AndroidJobError(400, "INVALID_PAYLOAD");
  return value.toLowerCase();
}
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
