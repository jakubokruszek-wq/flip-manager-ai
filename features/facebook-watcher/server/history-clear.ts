import "server-only";
import { createFacebookWatcherAdminClient } from "../supabase-admin";
import { planFacebookWatcherHistoryClear, type FacebookHistoryCandidate, type FacebookHistoryPlan } from "../history-clear";

const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running"];

export type FacebookWatcherHistorySummary = FacebookHistoryPlan & { total: number; ready: boolean; blockedReason: string | null };

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

async function readCandidates(): Promise<FacebookHistoryCandidate[]> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.from("listing_source_metadata").select("listing_id,metadata,listings(id,source)").eq("source", "facebook");
  if (result.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_READ_FAILED: ${result.error.message}`);
  const metadataRows = rows(result.data);
  const listingIds = [...new Set(metadataRows.map((item) => typeof item.listing_id === "string" ? item.listing_id : "").filter(Boolean))];
  if (!listingIds.length) return [];
  const [properties, deals] = await Promise.all([
    supabase.from("properties").select("listing_id").in("listing_id", listingIds),
    supabase.from("deals").select("listing_id").in("listing_id", listingIds),
  ]);
  if (properties.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_PROPERTY_READ_FAILED: ${properties.error.message}`);
  if (deals.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_DEAL_READ_FAILED: ${deals.error.message}`);
  const propertyIds = new Set(rows(properties.data).map((item) => item.listing_id).filter((value): value is string => typeof value === "string"));
  const dealIds = new Set(rows(deals.data).map((item) => item.listing_id).filter((value): value is string => typeof value === "string"));
  const byListing = new Map<string, FacebookHistoryCandidate>();
  for (const item of metadataRows) {
    const listingId = typeof item.listing_id === "string" ? item.listing_id : null;
    if (!listingId) continue;
    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Row : {};
    const current = byListing.get(listingId) ?? { listingId };
    byListing.set(listingId, { ...current, crossSourceMatch: current.crossSourceMatch === true || metadata.crossSourceMatch === true, linkedProperty: propertyIds.has(listingId), linkedDeal: dealIds.has(listingId) });
  }
  return [...byListing.values()];
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
  const [plan, blockedReason] = await Promise.all([readCandidates().then(planFacebookWatcherHistoryClear), activeBlock()]);
  return { ...plan, total: plan.pureFacebookListingIds.length + plan.preservedListingIds.length, ready: !blockedReason, blockedReason };
}

export async function clearFacebookWatcherHistory(): Promise<FacebookWatcherHistorySummary> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.rpc("clear_facebook_watcher_history_atomic").single();
  if (result.error || !result.data) {
    const code = result.error?.message.includes("ACTIVE_FACEBOOK_WORK") ? "ACTIVE_FACEBOOK_JOB" : "FACEBOOK_WATCHER_HISTORY_CLEAR_FAILED";
    throw new Error(`${code}: ${result.error?.message ?? "missing result"}`);
  }
  const value = result.data as { pure_facebook_listing_ids?: unknown; preserved_listing_ids?: unknown; removed_association_listing_ids?: unknown };
  const pureFacebookListingIds = uuidArray(value.pure_facebook_listing_ids);
  const preservedListingIds = uuidArray(value.preserved_listing_ids);
  const removedAssociationListingIds = uuidArray(value.removed_association_listing_ids);
  return { pureFacebookListingIds, preservedListingIds, removedAssociationListingIds, total: pureFacebookListingIds.length + preservedListingIds.length, ready: true, blockedReason: null };
}

function uuidArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
