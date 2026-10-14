import "server-only";

import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { createOlxWorkerAdminClient } from "@/features/flip-finder/server/olx-worker-admin";
import type { ClaimedOlxJob } from "@/features/flip-finder/server/olx-jobs";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";

/**
 * Unattended OLX (docs/olx-cloud-scheduled.md). The scheduled Cloudflare
 * Worker claims ONLY through claim_scheduled_finder_olx_job: one automatic
 * Finder job that the OLX schedule already admitted, never in parallel with
 * another OLX job, at most one per rolling 24 h, and only while the database
 * STOP switch (olx_automation_control) is on. The regular /claim, the
 * selective claim and Price Radar are unchanged.
 */

export type ScheduledClaimReason = "AUTOMATION_DISABLED" | "OLX_JOB_RUNNING" | "DAILY_CLAIM_USED" | "NO_DUE_JOB";
export type ScheduledClaimResult = { job: ClaimedOlxJob | null; reason: ScheduledClaimReason | null };

const REASONS = new Set<string>(["AUTOMATION_DISABLED", "OLX_JOB_RUNNING", "DAILY_CLAIM_USED", "NO_DUE_JOB"]);

export async function claimScheduledOlxJob(workerId: string, client?: DatabaseClient): Promise<ScheduledClaimResult> {
  if (workerId.trim().length < 3 || workerId.length > 100) throw new Error("INVALID_WORKER_ID");
  const supabase = client ?? createOlxWorkerAdminClient();
  const result = await supabase.rpc("claim_scheduled_finder_olx_job", { p_worker_id: workerId, p_lease_seconds: 120 });
  // A missing function (migration not applied) fails closed: nothing is claimed.
  if (result.error) throw new Error(result.error.code === "PGRST202" || result.error.code === "42883" ? "OLX_SCHEDULED_CLAIM_UNAVAILABLE" : `OLX_JOB_CLAIM_FAILED: ${result.error.message}`);
  return parseScheduledClaim(result.data);
}

/** Anything unexpected from the database is an error, never a job. */
export function parseScheduledClaim(value: unknown): ScheduledClaimResult {
  const row = asRow(value);
  if (!row) throw new Error("OLX_SCHEDULED_CLAIM_INVALID");
  const job = asRow(row.job);
  if (!job) {
    if (typeof row.reason !== "string" || !REASONS.has(row.reason)) throw new Error("OLX_SCHEDULED_CLAIM_INVALID");
    return { job: null, reason: row.reason as ScheduledClaimReason };
  }
  if (row.reason !== null || job.context_type !== "finder" || job.requested_by !== "scheduler" || job.status !== "running") throw new Error("OLX_SCHEDULED_CLAIM_MISMATCH");
  return {
    reason: null,
    job: {
      id: requiredString(job.id, "job id"),
      runId: requiredString(job.scan_run_id, "run id"),
      sourceScanId: nullableString(job.source_scan_id),
      filterId: nullableString(job.search_filter_id),
      contextType: "finder",
      radarOwnerId: null,
      radarRunLeaseToken: null,
      radarLeaseUntil: null,
      requestUrl: assertAllowedOlxUrl(requiredString(job.request_url, "request url")).toString(),
      leaseToken: requiredString(job.lease_token, "lease token"),
      leasedUntil: requiredString(job.leased_until, "leased until"),
      attempts: nonnegativeInteger(job.attempts),
    },
  };
}

/** Request body: exactly `{ workerId }`. No job id, filter or "oldest" selector. */
export function parseScheduledClaimBody(value: unknown): { workerId: string } {
  const row = asRow(value);
  if (!row || typeof row.workerId !== "string" || !row.workerId) throw new Error("INVALID_PAYLOAD");
  if (Object.keys(row).some((key) => key !== "workerId")) throw new Error("INVALID_SELECTOR");
  return { workerId: row.workerId };
}

export type ExpiredScheduledJobs = { unclaimedExpired: number; leaseExpired: number };

/**
 * Marks automatic jobs never claimed within the expiry (default 6 h) or whose
 * lease died as failed with OLX_SCHEDULED_JOB_NOT_CLAIMED /
 * OLX_SCHEDULED_JOB_LEASE_EXPIRED. Nothing is deleted or retried.
 */
export async function expireStaleScheduledOlxJobs(supabase: DatabaseClient): Promise<ExpiredScheduledJobs | null> {
  const result = await supabase.rpc("expire_stale_scheduled_finder_olx_jobs").abortSignal(AbortSignal.timeout(5_000));
  if (result.error) {
    // Before the migration: nothing to expire, nothing changes.
    if (result.error.code !== "PGRST202" && result.error.code !== "42883") console.warn("FINDER_OLX_EXPIRE_FAILED", { code: result.error.code ?? null, detail: (result.error.message ?? "").slice(0, 200) });
    return null;
  }
  const row = asRow(result.data);
  return { unclaimedExpired: count(row?.unclaimed_expired), leaseExpired: count(row?.lease_expired) };
}

type Row = Record<string, unknown>;
function asRow(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function requiredString(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${field.toUpperCase().replace(/\s+/g, "_")}`); return value.trim(); }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
function count(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0; }

export type OlxAutomationStatus = {
  available: boolean;
  enabled: boolean | null;
  maxClaims24h: number | null;
  unclaimedExpiryMinutes: number | null;
  note: string | null;
  updatedAt: string | null;
  recentJobs: Array<{ id: string; status: string; createdAt: string | null; startedAt: string | null; finishedAt: string | null; workerId: string | null; errorCode: string | null; attempts: number | null }>;
  waiting: number;
  running: number;
};

/** Read-only monitoring of unattended OLX: switch, last automatic jobs, waiting/running. */
export async function getOlxAutomationStatus(supabase: DatabaseClient): Promise<OlxAutomationStatus> {
  const [control, recent] = await Promise.all([
    supabase.from("olx_automation_control").select("scheduled_claim_enabled,max_claims_24h,unclaimed_expiry_minutes,note,updated_at").eq("id", 1).maybeSingle(),
    supabase.from("olx_scan_jobs").select("id,status,created_at,started_at,finished_at,worker_id,error_code,attempts")
      .eq("context_type", "finder").eq("requested_by", "scheduler").order("created_at", { ascending: false }).limit(5),
  ]);
  const jobs = Array.isArray(recent.data) ? (recent.data as Row[]) : [];
  const row = control.error ? null : asRow(control.data);
  return {
    available: !control.error && row !== null,
    enabled: row ? row.scheduled_claim_enabled === true : null,
    maxClaims24h: row && typeof row.max_claims_24h === "number" ? row.max_claims_24h : null,
    unclaimedExpiryMinutes: row && typeof row.unclaimed_expiry_minutes === "number" ? row.unclaimed_expiry_minutes : null,
    note: row ? nullableString(row.note) : null,
    updatedAt: row ? nullableString(row.updated_at) : null,
    recentJobs: jobs.map((job) => ({
      id: String(job.id), status: String(job.status), createdAt: nullableString(job.created_at), startedAt: nullableString(job.started_at),
      finishedAt: nullableString(job.finished_at), workerId: nullableString(job.worker_id), errorCode: nullableString(job.error_code),
      attempts: typeof job.attempts === "number" ? job.attempts : null,
    })),
    waiting: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
  };
}
