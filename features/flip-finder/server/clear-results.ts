import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getFilterResults } from "./filter-results";
import type { ClearResultsScope } from "@/features/flip-finder/clear-results-targeting";

export type { ClearResultsScope };
export type ClearResultsSummary = { archivedCount: number };

const WRITE_CHUNK_SIZE = 200;
export const FINDER_CLEARED_MATCH_REASON = "finder_cleared";

export class ClearResultsConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("Trwa skan lub przeliczanie wyników. Zakończ je i ponów czyszczenie.");
    this.name = "ClearResultsConflictError";
  }
}

/**
 * Hides only current MATCHED + REVIEW memberships for this filter. The actual
 * candidates come from the exact Finder read path, so price, publication age,
 * lifecycle, current decision and source validation cannot drift from the UI.
 * Listings, snapshots, CRM/deals and other filters are never modified.
 */
export async function clearFilterResults(filterId: string, scope: ClearResultsScope = {}): Promise<ClearResultsSummary> {
  const supabase = createAdminClient();
  await assertNoActiveFinderWork(supabase, filterId);
  const payload = await getFilterResults(filterId, false);
  if (!payload) throw new Error("Nie znaleziono filtra.");
  const cutoff = typeof scope.olderThanDays === "number" && scope.olderThanDays > 0
    ? Date.now() - scope.olderThanDays * 86_400_000
    : null;
  const targets = [...new Set([...payload.results, ...payload.reviewResults]
    .filter((result) => !scope.source || result.source === scope.source)
    .filter((result) => {
      if (cutoff === null) return true;
      const lastSeen = Date.parse(result.lastSeenAt);
      return Number.isFinite(lastSeen) && lastSeen < cutoff;
    })
    .map((result) => result.id))];
  if (!targets.length) return { archivedCount: 0 };

  // Recheck after the read/target computation. The SQL canonical RPC also
  // recognizes the per-membership tombstone below and rejects any older scan
  // observation that races this mutation.
  await assertNoActiveFinderWork(supabase, filterId);
  const clearedAt = new Date().toISOString();
  let affected = 0;
  for (let offset = 0; offset < targets.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + WRITE_CHUNK_SIZE);
    const update = await supabase.from("listing_filter_matches")
      .update({ is_current_match: false, match_reasons: [FINDER_CLEARED_MATCH_REASON], last_matched_at: clearedAt })
      .eq("search_filter_id", filterId)
      .in("listing_id", chunk)
      .select("listing_id");
    if (update.error) throw new Error("Nie udało się wyczyścić wyników filtra.");
    affected += Array.isArray(update.data) ? update.data.length : chunk.length;
  }
  return { archivedCount: affected };
}

async function assertNoActiveFinderWork(supabase: ReturnType<typeof createAdminClient>, filterId: string): Promise<void> {
  const active = await supabase.from("source_scans")
    .select("id")
    .eq("search_filter_id", filterId)
    .neq("source", "facebook")
    .in("status", ["pending", "running"])
    .limit(1);
  if (active.error) throw new Error("Nie udało się sprawdzić, czy skan filtra nadal trwa.");
  if (Array.isArray(active.data) && active.data.length > 0) throw new ClearResultsConflictError();
}
