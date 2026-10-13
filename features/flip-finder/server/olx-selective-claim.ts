import "server-only";

import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { createOlxWorkerAdminClient } from "@/features/flip-finder/server/olx-worker-admin";
import type { ClaimedOlxJob } from "@/features/flip-finder/server/olx-jobs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claims exactly one queued Finder OLX job, named by id
 * (claim_olx_scan_job_selective, migration 20261013180000). No other job is
 * read for update or changed. Used only by the Cloudflare worker's controlled
 * manual test; the regular claim (claimOlxJob) is untouched.
 */
export async function claimSelectedOlxJob(workerId: string, jobId: string): Promise<ClaimedOlxJob | null> {
  if (workerId.trim().length < 3 || workerId.length > 100) throw new Error("INVALID_WORKER_ID");
  if (!UUID.test(jobId)) throw new Error("INVALID_JOB_ID");
  const supabase = createOlxWorkerAdminClient();
  const result = await supabase.rpc("claim_olx_scan_job_selective", { p_worker_id: workerId, p_job_id: jobId, p_lease_seconds: 120 });
  // A missing function (migration not applied) fails closed: nothing is claimed.
  if (result.error) throw new Error(result.error.code === "PGRST202" || /claim_olx_scan_job_selective/.test(result.error.message) ? "OLX_SELECTIVE_CLAIM_UNAVAILABLE" : `OLX_JOB_CLAIM_FAILED: ${result.error.message}`);
  const row = Array.isArray(result.data) ? asRow(result.data[0]) : asRow(result.data);
  if (!row) return null;
  const job: ClaimedOlxJob = {
    id: requiredString(row.id, "job id"),
    runId: requiredString(row.scan_run_id, "run id"),
    sourceScanId: nullableString(row.source_scan_id),
    filterId: nullableString(row.search_filter_id),
    contextType: "finder",
    radarOwnerId: null,
    radarRunLeaseToken: null,
    radarLeaseUntil: null,
    requestUrl: assertAllowedOlxUrl(requiredString(row.request_url, "request url")).toString(),
    leaseToken: requiredString(row.lease_token, "lease token"),
    leasedUntil: requiredString(row.leased_until, "leased until"),
    attempts: nonnegativeInteger(row.attempts),
  };
  // Defence in depth: the SQL already guarantees both.
  if (row.context_type !== "finder" || job.id !== jobId) throw new Error("OLX_SELECTIVE_CLAIM_MISMATCH");
  return job;
}

/** Request body: `{ workerId, jobId }`; any other selector is rejected (no "oldest job", no filter). */
export function parseClaimSelector(value: unknown): { workerId: string; jobId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  const row = value as Record<string, unknown>;
  if (typeof row.workerId !== "string" || !row.workerId) throw new Error("INVALID_PAYLOAD");
  const allowed = new Set(["workerId", "jobId"]);
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error("INVALID_SELECTOR");
  if (typeof row.jobId !== "string" || !UUID.test(row.jobId)) throw new Error("INVALID_JOB_ID");
  return { workerId: row.workerId, jobId: row.jobId };
}

type Row = Record<string, unknown>;
function asRow(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${field.toUpperCase().replace(/\s+/g, "_")}`); return value.trim(); }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
