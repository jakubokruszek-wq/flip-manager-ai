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
    supabase.from("source_scans").select("id").eq("source", "facebook").in("status", ["running"]),
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
  const blockedReason = await activeBlock();
  if (blockedReason) throw new Error(blockedReason);
  const metadataResult = await supabase.from("listing_source_metadata").select("listing_id,metadata").eq("source", "facebook");
  if (metadataResult.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_READ_FAILED: ${metadataResult.error.message}`);
  const metadataRows = rows(metadataResult.data);
  const plan = await readCandidates().then(planFacebookWatcherHistoryClear);
  if (plan.pureFacebookListingIds.length) {
    const deleted = await supabase.from("listings").delete().in("id", plan.pureFacebookListingIds).eq("source", "facebook");
    if (deleted.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_DELETE_FAILED: ${deleted.error.message}`);
  }
  if (plan.preservedListingIds.length) {
    const association = await supabase.from("listing_source_metadata").delete().eq("source", "facebook").in("listing_id", plan.preservedListingIds);
    if (association.error) throw new Error(`FACEBOOK_WATCHER_HISTORY_ASSOCIATION_DELETE_FAILED: ${association.error.message}`);
  }
  return { ...plan, total: metadataRows.length, ready: true, blockedReason: null };
}
