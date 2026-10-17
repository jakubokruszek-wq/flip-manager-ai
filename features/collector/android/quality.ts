import type { FacebookCollectorBatch } from "../facebook-batch.ts";
import { resolveFacebookListingIntent } from "../../facebook-watcher/facebook-intent.ts";
import { FACEBOOK_SCAN_PRIMARY_OUTCOMES, validateFacebookScanAccounting, type FacebookPostOutcome, type FacebookScanAccounting } from "../../facebook-worker/scan-accounting.ts";

export type FacebookBatchQuality = {
  version: 1; capturedPosts: number; saleIntentPosts: number; confirmedIdentityPosts: number;
  missingDataPosts: number; rejectedPosts: number; missingDataReasons: Record<string, number>;
};
const ACCEPTED = new Set(["MATCHED", "REVIEW", "EXTRACTION_FAILED"]);
export function buildFacebookBatchQuality(batch: FacebookCollectorBatch, outcomes: FacebookPostOutcome[], conflicts: ReadonlySet<string>): FacebookBatchQuality {
  const missingDataReasons: Record<string, number> = {};
  let missingDataPosts = 0;
  for (const outcome of outcomes) {
    const missing = [...new Set(outcome.reasonCodes.filter(code => code.startsWith("unknown_") && safeReason(code)))];
    if (missing.length) missingDataPosts++;
    for (const reason of missing) missingDataReasons[reason] = (missingDataReasons[reason] ?? 0) + 1;
  }
  return { version: 1, capturedPosts: batch.posts.length,
    saleIntentPosts: batch.posts.filter(post => resolveFacebookListingIntent(post.text, null, null).intent === "SELL_PROPERTY").length,
    confirmedIdentityPosts: batch.posts.filter(post => post.identityConfidence === "EXACT" && !conflicts.has(post.postId)).length,
    missingDataPosts, rejectedPosts: outcomes.filter(outcome => !ACCEPTED.has(outcome.primaryOutcome)).length, missingDataReasons };
}
export type FacebookQualityJob = {
  id: string; scan_run_id: string; consumer_type: string; job_type: string; status: string; attempts: number;
  group_snapshot: unknown; result_summary?: unknown;
};
export const FACEBOOK_QUALITY_METRICS = ["postsCaptured", "postsWithSaleIntent", "postsWithConfirmedIdentity", "postsWithMissingData", "postsRejected", "listingsAdded", "listingsUpdated", "listingsDuplicated", "postsSkipped", "processingErrors"] as const;
export type FacebookQualityMetric = typeof FACEBOOK_QUALITY_METRICS[number];
export type FacebookQualityReport = {
  version: 1; source: "facebook"; runId: string; generatedAt: string;
  consumerTypes: string[]; groups: { planned: number; attempted: number; scanned: number; successful: number; failed: number };
  metrics: Record<FacebookQualityMetric, { value: number | null; observedJobs: number; totalJobs: number }>;
  rejectionReasons: Record<string, number>; missingDataReasons: Record<string, number>;
  failures: { terminalScans: number; leaseRecoveries: number; cancelledScans: number };
  coverage: { jobs: number; accountingJobs: number; qualityJobs: number; warnings: string[] };
  /** Legacy importer observations, not a count of distinct physical rows. */
  writeObservations: { reportedCreated: number; reportedUpdated: number };
};
/** Counts persisted observations only. Missing historical fields are null, never fabricated zeros. */
export function buildFacebookRunQualityReport(jobs: FacebookQualityJob[], input: { runId: string; now?: string; consumerTypes?: string[] }): FacebookQualityReport {
  const consumers = input.consumerTypes ?? ["ANDROID_WEBVIEW"];
  if (!consumers.length || consumers.some(c => !["ANDROID_WEBVIEW", "BROWSER_EXTENSION", "LEGACY_WORKER"].includes(c))) throw Error("FACEBOOK_REPORT_CONSUMER_INVALID");
  const rows = new Map<string, FacebookQualityJob>();
  for (const job of jobs) {
    if (job.scan_run_id !== input.runId || job.job_type !== "SOURCE_SCAN" || !consumers.includes(job.consumer_type)) continue;
    const old = rows.get(job.id);
    if (old && JSON.stringify(old) !== JSON.stringify(job)) throw Error("FACEBOOK_REPORT_CONFLICTING_JOB");
    rows.set(job.id, job);
  }
  const totals = Object.fromEntries(FACEBOOK_QUALITY_METRICS.map(key => [key, { value: null, observedJobs: 0, totalJobs: rows.size }])) as FacebookQualityReport["metrics"];
  const report: FacebookQualityReport = { version: 1, source: "facebook", runId: input.runId, generatedAt: input.now ?? new Date().toISOString(), consumerTypes: [...new Set(consumers)],
    groups: { planned: 0, attempted: 0, scanned: 0, successful: 0, failed: 0 }, metrics: totals, rejectionReasons: {}, missingDataReasons: {}, failures: { terminalScans: 0, leaseRecoveries: 0, cancelledScans: 0 }, coverage: { jobs: rows.size, accountingJobs: 0, qualityJobs: 0, warnings: [] }, writeObservations: { reportedCreated: 0, reportedUpdated: 0 } };
  const groups = { planned: new Set<string>(), attempted: new Set<string>(), scanned: new Set<string>(), successful: new Set<string>(), failed: new Set<string>() };
  let unverifiedCreated = false; let unverifiedUpdated = false;
  function observe(key: FacebookQualityMetric, value: unknown) {
    if (!count(value)) return;
    const metric = totals[key]; metric.value = (metric.value ?? 0) + value; metric.observedJobs++;
  }
  for (const job of rows.values()) {
    const group = Array.isArray(job.group_snapshot) ? object(job.group_snapshot[0]) : null;
    const groupId = `${String(group?.type ?? "GROUP")}:${String(group?.sourceId ?? group?.id ?? job.id)}`;
    groups.planned.add(groupId);
    if (job.attempts > 0) groups.attempted.add(groupId);
    if (job.status === "completed") groups.scanned.add(groupId);
    const cancelled = object(object(job.result_summary)?.result)?.cancelled === true;
    if (cancelled) report.failures.cancelledScans++;
    if (job.status === "completed" || job.status === "failed" && !cancelled) {
      groups[job.status === "completed" ? "successful" : "failed"].add(groupId);
    }
    if (job.status === "failed" && !cancelled) report.failures.terminalScans++;
    if (count(job.attempts)) report.failures.leaseRecoveries += Math.max(0, job.attempts - 1);
    const stored = object(job.result_summary);
    const summary = object(stored?.result) ?? stored;
    if (!summary || !["completed", "degraded", "failed"].includes(String(summary.status))) continue;
    observe("postsCaptured", summary.captured ?? summary.postsReceived);
    // Pre-upsert lookups cannot prove who inserted a row: another consumer/run
    // may win the race. Do not label these operation observations as distinct
    // additions/updates, even when this report contains only one job.
    if (count(summary.listingsCreated)) report.writeObservations.reportedCreated += summary.listingsCreated;
    if (count(summary.listingsUpdated)) report.writeObservations.reportedUpdated += summary.listingsUpdated;
    const writes = object(summary.writeAccounting);
    const exact = writes?.version === 1 && writes.basis === "TRANSACTIONAL" &&
      [writes.created, writes.updated, writes.duplicates, summary.skipped, summary.captured].every(count) &&
      Number(writes.created) + Number(writes.updated) + Number(writes.duplicates) + Number(summary.skipped) === summary.captured &&
      writes.created === summary.listingsCreated && writes.updated === summary.listingsUpdated;
    if (exact && writes) {
      observe("listingsAdded", writes.created); observe("listingsUpdated", writes.updated);
      observe("listingsDuplicated", writes.duplicates); observe("postsSkipped", summary.skipped);
    } else {
      if (summary.listingsCreated === 0) observe("listingsAdded", 0);
      if (summary.listingsUpdated === 0) observe("listingsUpdated", 0);
      unverifiedCreated ||= count(summary.listingsCreated) && summary.listingsCreated > 0;
      unverifiedUpdated ||= count(summary.listingsUpdated) && summary.listingsUpdated > 0;
      if ((count(summary.listingsCreated) && summary.listingsCreated > 0) || (count(summary.listingsUpdated) && summary.listingsUpdated > 0)) report.coverage.warnings.push("DISTINCT_LISTING_WRITES_UNVERIFIED");
    }
    observe("processingErrors", summary.errors);
    const accounting = readAccounting(summary.accounting);
    if (summary.accounting !== undefined && !accounting) report.coverage.warnings.push("INVALID_PERSISTED_ACCOUNTING");
    if (accounting) {
      report.coverage.accountingJobs++;
      // Reason counts can overlap. They must never be summed to infer rejected posts.
      addReasons(report.rejectionReasons, accounting.reasonCounts, code => !code.startsWith("unknown_"));
    }
    const quality = object(summary.quality);
    if (quality?.version === 1 && [quality.capturedPosts, quality.saleIntentPosts, quality.confirmedIdentityPosts, quality.missingDataPosts, quality.rejectedPosts].every(count)
      && quality.capturedPosts === summary.captured && [quality.saleIntentPosts, quality.confirmedIdentityPosts, quality.missingDataPosts, quality.rejectedPosts].every(n => (n as number) <= (quality.capturedPosts as number))) {
      report.coverage.qualityJobs++;
      observe("postsWithSaleIntent", quality.saleIntentPosts); observe("postsWithConfirmedIdentity", quality.confirmedIdentityPosts);
      observe("postsWithMissingData", quality.missingDataPosts); observe("postsRejected", quality.rejectedPosts);
      addReasons(report.missingDataReasons, quality.missingDataReasons, code => code.startsWith("unknown_"));
    }
  }
  for (const key of Object.keys(groups) as (keyof typeof groups)[]) report.groups[key] = groups[key].size;
  // A zero observed in one job cannot conceal an unverified positive in another.
  if (unverifiedCreated) totals.listingsAdded.value = null;
  if (unverifiedUpdated) totals.listingsUpdated.value = null;
  if (Object.values(totals).some(metric => metric.observedJobs < metric.totalJobs)) report.coverage.warnings.push("PARTIAL_HISTORICAL_COVERAGE");
  report.coverage.warnings = [...new Set(report.coverage.warnings)];
  return report;
}
function readAccounting(value: unknown): FacebookScanAccounting | null {
  const row = object(value); const outcomes = object(row?.byOutcome); const reasons = object(row?.reasonCounts);
  if (!row || !outcomes || !reasons || !FACEBOOK_SCAN_PRIMARY_OUTCOMES.every(key => count(outcomes[key]))) return null;
  const accounting = row as unknown as FacebookScanAccounting;
  return validateFacebookScanAccounting(accounting).ok ? accounting : null;
}
function addReasons(target: Record<string, number>, value: unknown, predicate: (key: string) => boolean) {
  const row = object(value); if (!row) return;
  for (const [key, n] of Object.entries(row)) if (safeReason(key) && predicate(key) && count(n)) target[key] = (target[key] ?? 0) + n;
}
function safeReason(key: string): boolean { return /^[A-Za-z0-9_:-]{1,100}$/.test(key) && !Object.prototype.hasOwnProperty.call(Object.prototype, key) && key !== "prototype"; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647; }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
