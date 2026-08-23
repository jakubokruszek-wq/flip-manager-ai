import "server-only";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { DEFAULT_REVALIDATION_BATCH_SIZE, classifyAvailabilityResponse, isTemporaryAvailabilityError, nextAvailabilityCheck, transitionListingLifecycle, type AvailabilityResult } from "./availability";

type Row = Record<string, unknown>;
type Probe = { listingId: string; source: string; result: AvailabilityResult; httpStatus: number | null };

export async function getListingLifecycleDryRun(probeLimit = 0) {
  const supabase = createFacebookWatcherAdminClient();
  const now = new Date().toISOString();
  const [active, removed, total, candidates] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "removed"),
    supabase.from("listings").select("id", { count: "exact", head: true }),
    supabase.from("listings").select("id,source,original_url,status,availability_miss_count,removed_at,last_seen_at,availability_next_check_at").eq("status", "active").or(`availability_next_check_at.is.null,availability_next_check_at.lte.${now}`).order("last_seen_at", { ascending: true }).limit(DEFAULT_REVALIDATION_BATCH_SIZE),
  ]);
  const error = active.error ?? removed.error ?? total.error ?? candidates.error;
  if (error) throw new Error(`Nie udało się przygotować lifecycle dry run: ${error.message}`);
  const selected = rows(candidates.data);
  const probes: Probe[] = [];
  for (const row of selected.slice(0, Math.max(0, Math.min(probeLimit, DEFAULT_REVALIDATION_BATCH_SIZE)))) probes.push(await probeListing(row));
  return {
    active: active.count ?? 0,
    removed: removed.count ?? 0,
    total: total.count ?? 0,
    needsRevalidation: selected.length,
    batchLimit: DEFAULT_REVALIDATION_BATCH_SIZE,
    probed: probes.length,
    wouldMarkRemoved: probes.filter((probe) => probe.result === "explicit_removed").length,
    temporaryFailures: probes.filter((probe) => probe.result === "temporary_failure").length,
    unchanged: probes.filter((probe) => probe.result !== "explicit_removed").length,
    probes,
  };
}

export async function runListingLifecycleBatch() {
  const supabase = createFacebookWatcherAdminClient();
  const now = new Date();
  const { data, error } = await supabase.from("listings").select("id,source,original_url,status,availability_miss_count,removed_at,last_seen_at,availability_next_check_at").in("status", ["active", "removed"]).or(`availability_next_check_at.is.null,availability_next_check_at.lte.${now.toISOString()}`).order("last_seen_at", { ascending: true }).limit(DEFAULT_REVALIDATION_BATCH_SIZE);
  if (error) throw new Error(`Nie udało się pobrać ofert do rewalidacji: ${error.message}`);
  const results = [];
  for (const row of rows(data)) {
    const probe = await probeListing(row);
    const state = { status: row.status === "removed" ? "removed" as const : "active" as const, missCount: integer(row.availability_miss_count), removedAt: string(row.removed_at) };
    const transition = transitionListingLifecycle(state, probe.result, now.toISOString());
    const update = await supabase.from("listings").update({ status: transition.status, removed_at: transition.removedAt, availability_miss_count: transition.missCount, availability_last_checked_at: now.toISOString(), availability_next_check_at: nextAvailabilityCheck(probe.result, now), availability_last_result: probe.result, availability_last_http_status: probe.httpStatus }).eq("id", probe.listingId);
    if (update.error) throw new Error(`Nie udało się zapisać lifecycle oferty: ${update.error.message}`);
    if (transition.status === "removed") {
      const matches = await supabase.from("listing_filter_matches").update({ is_current_match: false }).eq("listing_id", probe.listingId).eq("is_current_match", true);
      if (matches.error) throw new Error(`Nie udało się wyłączyć dopasowań usuniętej oferty: ${matches.error.message}`);
    }
    results.push({ ...probe, status: transition.status, statusChanged: transition.statusChanged });
  }
  return { checked: results.length, results };
}

async function probeListing(row: Row): Promise<Probe> {
  const listingId = string(row.id) ?? ""; const source = string(row.source) ?? ""; const url = string(row.original_url);
  if (!url) return { listingId, source, result: "ambiguous_missing", httpStatus: null };
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { accept: "text/html,application/xhtml+xml" } });
    const body = (await response.text()).slice(0, 250_000);
    return { listingId, source, result: classifyAvailabilityResponse({ source, status: response.status, body }), httpStatus: response.status };
  } catch (error) {
    return { listingId, source, result: isTemporaryAvailabilityError(error) ? "temporary_failure" : "ambiguous_missing", httpStatus: null };
  }
}

function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function integer(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
