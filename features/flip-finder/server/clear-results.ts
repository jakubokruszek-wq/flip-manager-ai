import "server-only";

import { createClient } from "@/lib/supabase/server";
import { selectClearResultsTargets, selectVisibleListingIds, type ClearResultsScope } from "@/features/flip-finder/clear-results-targeting";
import type { ListingSource } from "@/features/flip-finder";

export type { ClearResultsScope };
export type ClearResultsSummary = { archivedCount: number };

/**
 * "Wyczyść wyniki" hides current Finder results without destroying any
 * history: it only sets `lifecycle_status = 'ARCHIVED'` (the same soft-hide
 * state the visibility-lifecycle cron already uses for stale listings) and
 * deactivates this filter's membership row. It never deletes rows in
 * `listings`, `listing_snapshots`, `listing_source_metadata`, `properties`,
 * `deals`, or any other table — every one of those keeps every row it had.
 * A cleared listing can be restored by resetting `lifecycle_status`/
 * `archived_at` directly; nothing about the clear is destructive.
 */
export async function clearFilterResults(filterId: string, scope: ClearResultsScope = {}): Promise<ClearResultsSummary> {
  const supabase = await createClient();
  const matches = await supabase
    .from("listing_filter_matches")
    .select("listing_id,is_current_match,match_reasons")
    .eq("search_filter_id", filterId);
  if (matches.error) throw new Error("Nie udało się odczytać wyników filtra.");
  const listingIds = selectVisibleListingIds(
    (matches.data ?? []).map((row) => ({
      listingId: String(row.listing_id),
      isCurrentMatch: row.is_current_match === true,
      matchReasons: Array.isArray(row.match_reasons) ? row.match_reasons.filter((reason): reason is string => typeof reason === "string") : [],
    })),
  );
  if (!listingIds.length) return { archivedCount: 0 };

  const candidates = await supabase
    .from("listings")
    .select("id,source,lifecycle_status,last_seen_at")
    .in("id", listingIds);
  if (candidates.error) throw new Error("Nie udało się wyznaczyć ofert do wyczyszczenia.");
  const targetIds = selectClearResultsTargets(
    (candidates.data ?? []).map((row) => ({
      id: String(row.id),
      source: row.source as ListingSource,
      lifecycleStatus: typeof row.lifecycle_status === "string" ? row.lifecycle_status : null,
      lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    })),
    scope,
    Date.now(),
  );
  if (!targetIds.length) return { archivedCount: 0 };

  const now = new Date().toISOString();
  const archived = await supabase
    .from("listings")
    .update({ lifecycle_status: "ARCHIVED", archived_at: now })
    .in("id", targetIds)
    .select("id");
  if (archived.error) throw new Error("Nie udało się wyczyścić wyników.");

  const deactivated = await supabase
    .from("listing_filter_matches")
    .update({ is_current_match: false })
    .eq("search_filter_id", filterId)
    .in("listing_id", targetIds);
  if (deactivated.error) throw new Error("Nie udało się zaktualizować dopasowań filtra.");

  return { archivedCount: archived.data?.length ?? targetIds.length };
}
