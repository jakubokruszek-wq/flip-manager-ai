import "server-only";

import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { createOlxWorkerAdminClient } from "@/features/flip-finder/server/olx-worker-admin";
import type { ClaimedOlxJob } from "@/features/flip-finder/server/olx-jobs";

export type OlxClaimSelector = { jobId: string; filterId?: undefined } | { filterId: string; jobId?: undefined };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claims exactly one queued Finder OLX job selected by id or search filter
 * (claim_olx_scan_job_selective, migration 20261013150000). Other jobs are
 * never read for update or changed. Used only by the Cloudflare worker's
 * manual trial; the regular claim (claimOlxJob) is untouched.
 */
export async function claimSelectedOlxJob(workerId: string, selector: OlxClaimSelector): Promise<ClaimedOlxJob | null> {
  if (workerId.trim().length < 3 || workerId.length > 100) throw new Error("INVALID_WORKER_ID");
  const target = selector.jobId ?? selector.filterId;
  if (!target || !UUID.test(target)) throw new Error("INVALID_SELECTOR");
  const supabase = createOlxWorkerAdminClient();
  const result = await supabase.rpc("claim_olx_scan_job_selective", {
    p_worker_id: workerId,
    p_job_id: selector.jobId ?? null,
    p_search_filter_id: selector.filterId ?? null,
    p_lease_seconds: 120,
  });
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
  if (row.context_type !== "finder" || (selector.jobId && job.id !== selector.jobId) || (selector.filterId && job.filterId !== selector.filterId)) {
    throw new Error("OLX_SELECTIVE_CLAIM_MISMATCH");
  }
  return job;
}

export function parseClaimSelector(value: unknown): { workerId: string; selector: OlxClaimSelector } {
  if (!value || typeof value !== "object") throw new Error("INVALID_PAYLOAD");
  const row = value as Record<string, unknown>;
  if (typeof row.workerId !== "string" || !row.workerId) throw new Error("INVALID_PAYLOAD");
  const jobId = typeof row.jobId === "string" && row.jobId ? row.jobId : null;
  const filterId = typeof row.filterId === "string" && row.filterId ? row.filterId : null;
  if ((jobId === null) === (filterId === null)) throw new Error("INVALID_SELECTOR");
  const target = (jobId ?? filterId) as string;
  if (!UUID.test(target)) throw new Error("INVALID_SELECTOR");
  return { workerId: row.workerId, selector: jobId ? { jobId } : { filterId: filterId as string } };
}

type Row = Record<string, unknown>;
function asRow(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${field.toUpperCase().replace(/\s+/g, "_")}`); return value.trim(); }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
