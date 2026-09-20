import "server-only";
import { createFacebookWatcherAdminClient } from "../supabase-admin";
import type { FacebookHistoryPlan } from "../history-clear";

const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running"];

export type FacebookWatcherHistorySummary = FacebookHistoryPlan & { total: number; ready: boolean; blockedReason: string | null };

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

type HistoryPlanRow = { pure_facebook_listing_ids?: unknown; preserved_listing_ids?: unknown; removed_association_listing_ids?: unknown };

function planFromRpcRow(value: unknown): FacebookHistoryPlan {
  const row = (value ?? {}) as HistoryPlanRow;
  return {
    pureFacebookListingIds: uuidArray(row.pure_facebook_listing_ids),
    preservedListingIds: uuidArray(row.preserved_listing_ids),
    removedAssociationListingIds: uuidArray(row.removed_association_listing_ids),
  };
}

async function readSummaryPlan(): Promise<FacebookHistoryPlan> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.rpc("get_facebook_watcher_history_summary").single();
  if (result.error || !result.data) throw new Error(`FACEBOOK_WATCHER_HISTORY_READ_FAILED: ${result.error?.message ?? "missing result"}`);
  return planFromRpcRow(result.data);
}

async function activeBlock(): Promise<string | null> {
  const supabase = createFacebookWatcherAdminClient();
  const [scans, jobs] = await Promise.all([
    supabase.from("source_scans").select("id").eq("source", "facebook").in("status", ["pending", "running"]),
    supabase.from("facebook_scan_jobs").select("id,job_type,status").in("status", ACTIVE_JOB_STATUSES),
  ]);
  if (scans.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_SCAN_READ_FAILED: ${scans.error.message}`);
  if (jobs.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_JOB_READ_FAILED: ${jobs.error.message}`);
  if (rows(scans.data).length) return "ACTIVE_FACEBOOK_SOURCE_SCAN";
  if (rows(jobs.data).some((job) => job.job_type === "SOURCE_SCAN" || job.job_type === "GALLERY_HYDRATION")) return "ACTIVE_FACEBOOK_JOB";
  return null;
}

export async function getFacebookWatcherHistorySummary(): Promise<FacebookWatcherHistorySummary> {
  const [plan, blockedReason] = await Promise.all([readSummaryPlan(), activeBlock()]);
  return { ...plan, total: plan.pureFacebookListingIds.length + plan.preservedListingIds.length, ready: !blockedReason, blockedReason };
}

export async function clearFacebookWatcherHistory(): Promise<FacebookWatcherHistorySummary> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.rpc("clear_facebook_watcher_history_atomic").single();
  if (result.error || !result.data) {
    const code = result.error?.message.includes("ACTIVE_FACEBOOK_WORK") ? "ACTIVE_FACEBOOK_JOB" : "FACEBOOK_WATCHER_HISTORY_CLEAR_FAILED";
    throw new Error(`${code}: ${result.error?.message ?? "missing result"}`);
  }
  const plan = planFromRpcRow(result.data);
  return { ...plan, total: plan.pureFacebookListingIds.length + plan.preservedListingIds.length, ready: true, blockedReason: null };
}

function uuidArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
