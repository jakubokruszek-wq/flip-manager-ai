import "server-only";

import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { buildOpenAICostDashboard } from "@/features/flip-finder/scan-cost";
import {
  buildOverallProgress,
  collectorProgressGroupFromSourceScan,
  type FacebookGroupProgress,
  type ScanProgressResponse,
  type ScanWorkUnit,
  type WorkerJobStatus,
} from "@/features/flip-finder/scan-progress";
import type { ListingSource } from "@/features/flip-finder";

type Row = Record<string, unknown>;
const FACEBOOK_PENDING_TIMEOUT_MS = 90_000;

export async function getScanProgress(runId: string): Promise<ScanProgressResponse> {
  if (!isUuid(runId)) throw new Error("INVALID_SCAN_RUN_ID");
  const supabase = createFacebookWatcherAdminClient();
  await expireUnclaimedFacebookJobs(supabase, runId);
  const monthStart = zonedPeriodStart("month");
  const todayStart = zonedPeriodStart("day");
  const [scansResult, facebookResult, olxResult, monthJobsResult] = await Promise.all([
    supabase.from("source_scans").select("id,source,status,started_at,finished_at,scanned_count,matched_count,listings_found,listings_updated,price_drop_count,error_message,warnings").eq("scan_run_id", runId).order("started_at", { ascending: true }),
    supabase.from("facebook_scan_jobs").select("id,source_scan_id,status,group_snapshot,result_summary,error_code,error_message,created_at,started_at,finished_at,heartbeat_at").eq("scan_run_id", runId).order("created_at", { ascending: true }),
    supabase.from("olx_scan_jobs").select("id,source_scan_id,status,result_summary,error_code,error_message,created_at,started_at,finished_at,heartbeat_at").eq("scan_run_id", runId).maybeSingle(),
    supabase.from("facebook_scan_jobs").select("scan_run_id,result_summary,finished_at").eq("status", "completed").gte("finished_at", monthStart),
  ]);

  const databaseError = scansResult.error ?? facebookResult.error ?? olxResult.error ?? monthJobsResult.error;
  if (databaseError) throw new Error(`SCAN_PROGRESS_READ_FAILED: ${databaseError.message}`);

  const scanRows = rows(scansResult.data);
  if (scanRows.length === 0) throw new Error("SCAN_RUN_NOT_FOUND");
  const facebookRows = rows(facebookResult.data);
  const jobSourceScanIds = new Set(facebookRows.map((item) => string(item.source_scan_id)).filter((value): value is string => Boolean(value)));
  const collectorSourceScans = scanRows
    .filter((item) => item.source === "facebook" && typeof item.id === "string" && !jobSourceScanIds.has(String(item.id)))
    .map(toCollectorGroup);
  const olxRow = row(olxResult.data);
  const units = scanRows.map(toWorkUnit).filter((value): value is ScanWorkUnit => value !== null);
  const facebookGroups = [...facebookRows.map(toFacebookGroup), ...collectorSourceScans];
  const jobStatuses = [...facebookGroups.map((group) => group.status), ...(olxRow ? [jobStatus(olxRow.status)] : [])].filter((status): status is WorkerJobStatus => status !== null);
  const overall = buildOverallProgress(units, jobStatuses);
  const startedAt = units.map((unit) => unit.startedAt).sort()[0];
  const finishedAt = isTerminal(overall.status) ? latestDate(units.map((unit) => unit.finishedAt)) : null;
  const now = Date.now();
  const startedMs = Date.parse(startedAt);
  const endMs = finishedAt ? Date.parse(finishedAt) : now;

  const monthRows = rows(monthJobsResult.data);
  const monthlyBudgetUsd = configuredBudget();
  const cost = buildOpenAICostDashboard({
    runResults: facebookRows.map((item) => item.result_summary),
    monthJobs: monthRows.flatMap((item) => {
      const finishedAtValue = string(item.finished_at);
      return finishedAtValue ? [{ finishedAt: finishedAtValue, resultSummary: item.result_summary }] : [];
    }),
    todayStart,
    monthlyBudgetUsd,
  });
  const olxSummary = row(olxRow?.result_summary);
  const errors = unique([
    ...scanRows.flatMap((item) => string(item.error_message) ? [String(item.error_message)] : []),
    ...facebookRows.flatMap((item) => string(item.error_message) ? [String(item.error_message)] : []),
    ...(string(olxRow?.error_message) ? [String(olxRow?.error_message)] : []),
  ]);
  const currentFacebook = facebookGroups.find((group) => group.status === "running");
  const queuedFacebook = facebookGroups.find((group) => group.status === "queued");
  const currentUnit = units.find((unit) => unit.status === "running");
  const pendingUnit = units.find((unit) => unit.status === "pending");

  return {
    runId,
    status: overall.status,
    startedAt,
    finishedAt,
    elapsedMs: Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : 0,
    overall: {
      completedUnits: overall.completedUnits,
      totalUnits: overall.totalUnits,
      percent: overall.percent,
      failedUnits: overall.failedUnits,
      remainingUnits: overall.remainingUnits,
    },
    current: currentFacebook
      ? { source: "facebook", groupName: currentFacebook.groupName }
      : currentUnit
        ? { source: currentUnit.source, groupName: null }
        : queuedFacebook
          ? { source: "facebook", groupName: queuedFacebook.groupName }
          : pendingUnit ? { source: pendingUnit.source, groupName: null } : null,
    facebook: {
      totalGroups: facebookGroups.length,
      completedGroups: facebookGroups.filter((group) => group.status === "completed").length,
      runningGroups: facebookGroups.filter((group) => group.status === "running").length,
      queuedGroups: facebookGroups.filter((group) => group.status === "queued").length,
      failedGroups: facebookGroups.filter((group) => group.status === "failed").length,
      discovered: facebookGroups.reduce((total, group) => total + group.discovered, 0),
      processed: facebookGroups.reduce((total, group) => total + group.processed, 0),
      groups: facebookGroups,
    },
    olx: {
      status: jobStatus(olxRow?.status),
      raw: number(olxSummary?.fetched),
      normalized: number(olxSummary?.normalized),
      processed: number(olxSummary?.normalized),
      errorMessage: string(olxRow?.error_message),
    },
    totals: {
      scanned: sum(scanRows, "scanned_count"),
      matched: sum(scanRows, "matched_count"),
      updated: sum(scanRows, "listings_updated"),
      priceDrops: sum(scanRows, "price_drop_count"),
    },
    errors,
    openai: {
      lastRun: cost.lastRun,
      today: cost.today,
      month: cost.month,
      monthlyBudgetUsd,
      remainingBudgetUsd: cost.remainingBudgetUsd,
      budgetUsedPercent: cost.budgetUsedPercent,
      balanceUsd: null,
      balanceStatus: "UNAVAILABLE",
    },
  };
}

async function expireUnclaimedFacebookJobs(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, runId: string): Promise<void> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - FACEBOOK_PENDING_TIMEOUT_MS).toISOString();
  const expired = await supabase.from("facebook_scan_jobs").update({
    status: "failed",
    finished_at: now,
    error_code: "COLLECTOR_NOT_AVAILABLE",
    error_message: "Facebook Collector did not claim the queued job within 90 seconds",
  }).eq("scan_run_id", runId).eq("status", "queued").lt("created_at", cutoff).select("source_scan_id");
  if (expired.error) throw new Error(`FACEBOOK_PENDING_WATCHDOG_FAILED: ${expired.error.message}`);
  const sourceScanIds = rows(expired.data).map((item) => string(item.source_scan_id)).filter((value): value is string => Boolean(value));
  if (sourceScanIds.length === 0) return;
  const scans = await supabase.from("source_scans").update({
    status: "failed",
    finished_at: now,
    error_message: "COLLECTOR_NOT_AVAILABLE: Facebook Collector did not claim the queued job within 90 seconds",
  }).in("id", sourceScanIds).eq("status", "pending");
  if (scans.error) throw new Error(`FACEBOOK_PENDING_SOURCE_FINALIZE_FAILED: ${scans.error.message}`);
}

function toWorkUnit(value: Row): ScanWorkUnit | null {
  const id = string(value.id);
  const source = listingSource(value.source);
  const status = sourceStatus(value.status);
  const startedAt = string(value.started_at);
  if (!id || !source || !status || !startedAt) return null;
  return {
    id, source, status, startedAt, finishedAt: string(value.finished_at),
    scannedCount: number(value.scanned_count), matchedCount: number(value.matched_count),
    normalizedCount: number(value.listings_found), errorMessage: string(value.error_message),
  };
}

function toFacebookGroup(value: Row): FacebookGroupProgress {
  const snapshot = Array.isArray(value.group_snapshot) ? row(value.group_snapshot[0]) : null;
  const summary = row(value.result_summary);
  return {
    groupId: string(snapshot?.id), groupName: string(snapshot?.name) ?? "Grupa Facebook",
    jobId: string(value.id) ?? "", sourceScanId: string(value.source_scan_id) ?? "",
    status: jobStatus(value.status) ?? "queued",
    discovered: number(row(summary?.performance)?.postsDiscovered ?? summary?.postsReceived),
    processed: number(summary?.postsProcessed), errorMessage: string(value.error_message),
  };
}

function toCollectorGroup(value: Row): FacebookGroupProgress {
  return collectorProgressGroupFromSourceScan({ id: String(value.id), status: String(value.status), scannedCount: number(value.scanned_count), errorMessage: string(value.error_message) });
}

function configuredBudget(): number | null {
  const parsed = Number(process.env.OPENAI_MONTHLY_BUDGET_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function zonedPeriodStart(period: "day" | "month", now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace("GMT", "") || "+00:00";
  return new Date(`${get("year")}-${get("month")}-${period === "month" ? "01" : get("day")}T00:00:00${offset}`).toISOString();
}

function latestDate(values: Array<string | null>): string | null { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function isTerminal(status: ScanProgressResponse["status"]): boolean { return status === "completed" || status === "partial" || status === "failed"; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(row(item))) : []; }
function row(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function sum(values: Row[], key: string): number { return values.reduce((total, value) => total + number(value[key]), 0); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function listingSource(value: unknown): ListingSource | null { return value === "facebook" || value === "olx" || value === "otodom" || value === "morizon" ? value : null; }
function sourceStatus(value: unknown): ScanWorkUnit["status"] | null { return value === "pending" || value === "running" || value === "completed" || value === "partial" || value === "failed" ? value : null; }
function jobStatus(value: unknown): WorkerJobStatus | null { return value === "queued" || value === "running" || value === "completed" || value === "failed" ? value : null; }
