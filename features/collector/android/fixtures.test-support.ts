import { randomUUID } from "node:crypto";
import type { AndroidJobRow, AndroidJobStore, AndroidReceipt } from "./jobs.ts";

export const DEVICE = "11111111-1111-4111-8111-111111111111";
export const OTHER_DEVICE = "11111111-1111-4111-8111-111111111112";
export const RUN = "22222222-2222-4222-8222-222222222222";
export const COMPLETION = "33333333-3333-4333-8333-333333333333";
export const SOURCE_SCAN = "44444444-4444-4444-8444-444444444444";
export function jobRow(extra: Partial<AndroidJobRow> = {}): AndroidJobRow {
  return { id: "55555555-5555-4555-8555-555555555555", scan_run_id: RUN, source_scan_id: SOURCE_SCAN,
    search_filter_id: "66666666-6666-4666-8666-666666666666", consumer_type: "ANDROID_WEBVIEW", job_type: "SOURCE_SCAN", status: "running",
    group_snapshot: [{ id: "watched-group", name: "Mock group", sourceId: "mock-group", url: "https://www.facebook.com/groups/mock-group/", type: "GROUP" }],
    worker_id: DEVICE, lease_token: "77777777-7777-4777-8777-777777777777", leased_until: new Date(Date.now() + 180_000).toISOString(), attempts: 1, ...extra };
}
export function completionPayload(job = jobRow()) {
  return { jobId: job.id, leaseToken: job.lease_token, completionId: COMPLETION, dataMode: "LIVE", status: "completed", batch: {
    scanId: RUN, batchId: COMPLETION, sourceId: "mock-group", sourceType: "GROUP", sourceUrl: "https://www.facebook.com/groups/mock-group/",
    collectedAt: new Date().toISOString(), imageMode: "SOURCE_SCAN_DATA_ONLY",
    health: { status: "HEALTHY", visibleCardCount: 0, capturedPostCount: 0, scrolls: 0, durationMs: 0, stopReason: "NO_NEW_IDS", reasons: [] }, posts: [] as unknown[],
  } };
}
// Mock of the transactional RPC boundary, not production processing code.
// PostgreSQL syntax/locks require a separate isolated DB check before promotion.
export class MockAndroidStore implements AndroidJobStore {
  jobs: AndroidJobRow[];
  reservations = new Map<string, { id: unknown; hash: unknown; receipt?: AndroidReceipt }>();
  calls: string[] = [];
  completedBatches: { binding: { deviceId: string; batchId: string; runId: string; sourceScanId: string; sourceId: string; sourceUrl: string }; result: { status: string } }[] = [];
  async loadCompletedBatch(binding: { deviceId: string; batchId: string; runId: string; sourceScanId: string; sourceId: string; sourceUrl: string }) {
    return this.completedBatches.find(row => JSON.stringify(row.binding) === JSON.stringify(binding))?.result ?? null;
  }
  unavailable = false;
  now = Date.now();
  constructor(jobs = [jobRow()]) { this.jobs = jobs; }
  async loadJob(id: string) { return this.jobs.find(j => j.id === id) ?? null; }
  async rpc(name: string, p: Record<string, unknown>) {
    this.calls.push(name);
    if (this.unavailable) return { data: null, error: { message: "offline" } };
    if (name === "claim_android_facebook_scan_job") {
      const android = this.jobs.filter(j => j.consumer_type === "ANDROID_WEBVIEW" && j.job_type === "SOURCE_SCAN");
      if (android.some(j => j.worker_id === p.p_device_id && j.status === "running" && this.reservations.has(j.id))) return { data: [], error: null };
      let job = android.find(j => j.status === "running" && j.worker_id === p.p_device_id && Date.parse(j.leased_until ?? "") > this.now);
      const selected = (j: AndroidJobRow) => p.p_source_ids === undefined || Array.isArray(p.p_source_ids) && p.p_source_ids.includes((j.group_snapshot as { id: string }[])[0].id);
      if (job && !selected(job)) return { data: [], error: null };
      if (!job) {
        for (const old of android) if (old.status === "running" && Date.parse(old.leased_until ?? "") <= this.now && !this.reservations.has(old.id)) {
          if (old.attempts >= (old.max_attempts ?? 3)) { old.status = "failed"; old.leased_until = null; }
          else { old.status = "queued"; old.worker_id = ""; old.lease_token = ""; old.available_at = new Date(this.now + 15_000).toISOString(); }
        }
        job = android.find(j => selected(j) && !this.reservations.has(j.id) && j.attempts < (j.max_attempts ?? 3) && (!j.available_at || Date.parse(j.available_at) <= this.now) && (j.status === "queued" || j.status === "running" && Date.parse(j.leased_until ?? "") <= this.now));
        if (job) { job.status = "running"; job.attempts++; job.worker_id = String(p.p_device_id); job.lease_token = randomUUID(); job.leased_until = new Date(this.now + 180_000).toISOString(); }
      }
      return { data: job ? [{ ...job }] : [], error: null };
    }
    const job = this.jobs.find(j => j.id === p.p_job_id && j.consumer_type === "ANDROID_WEBVIEW" && j.job_type === "SOURCE_SCAN" && j.worker_id === p.p_device_id && j.lease_token === p.p_lease_token);
    if (name === "renew_android_facebook_scan_job") {
      if (!job || job.status !== "running" || Date.parse(job.leased_until ?? "") <= this.now) return { data: [], error: null };
      job.leased_until = new Date(this.now + 180_000).toISOString();
      return { data: [{ leased_until: job.leased_until }], error: null };
    }
    if (name === "begin_android_facebook_completion") {
      if (!job) return { data: { outcome: "lost" }, error: null };
      const old = this.reservations.get(job.id);
      if (old) return { data: old.id !== p.p_completion_id || old.hash !== p.p_payload_hash ? { outcome: "conflict" } : old.receipt ? { outcome: "duplicate", receipt: old.receipt } : { outcome: "busy" }, error: null };
      if (job.status !== "running" || Date.parse(job.leased_until ?? "") <= this.now) return { data: { outcome: "lost" }, error: null };
      if ([...this.reservations.values()].some(r => r.id === p.p_completion_id)) return { data: { outcome: "conflict" }, error: null };
      this.reservations.set(job.id, { id: p.p_completion_id, hash: p.p_payload_hash });
      job.android_completion_state = "processing"; job.android_completion_started_at = new Date(this.now).toISOString();
      return { data: { outcome: "reserved" }, error: null };
    }
    if (name === "finish_android_facebook_completion") {
      const old = job && this.reservations.get(job.id);
      if (!job || !old || old.id !== p.p_completion_id || old.hash !== p.p_payload_hash) return { data: null, error: null };
      if (old.receipt) return { data: old.receipt, error: null };
      old.receipt = p.p_receipt as AndroidReceipt; job.status = old.receipt.status;
      job.android_completion_state = "settled"; job.android_receipt = old.receipt; job.leased_until = null;
      return { data: old.receipt, error: null };
    }
    throw Error(`Unexpected RPC: ${name}`);
  }
}
