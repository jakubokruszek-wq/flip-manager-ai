import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getFilterResults } from "./filter-results";
import type { ClearResultsScope } from "@/features/flip-finder/clear-results-targeting";

export type { ClearResultsScope };
export type ClearResultsSummary = {
  archivedCount: number;
  /** Archived memberships per portal, so the operator sees every portal a clear touched. */
  bySource: Record<string, number>;
  /** Copies archived only because they are linked to a card of the selected source. */
  linkedCopiesFromOtherSources: number;
};

const WRITE_CHUNK_SIZE = 200;
export const FINDER_CLEARED_MATCH_REASON = "finder_cleared";

export class ClearResultsLinkedCopiesError extends Error {
  readonly status = 409;
  readonly code = "CLEAR_RESULTS_LINKED_COPIES";
  readonly linkedCards: number;
  readonly otherSources: Record<string, number>;
  constructor(linkedCards: number, otherSources: Record<string, number>) {
    super(`Zakres obejmuje ${linkedCards} ${linkedCards === 1 ? "kartę połączoną" : "karty połączone"} z ofertami z innych portali (${Object.entries(otherSources).map(([source, count]) => `${source}: ${count}`).join(", ")}). `
      + "Wyczyszczenie ukryje te kopie razem z kartą — inaczej wróciłyby jako osobne karty. Potwierdź, aby kontynuować.");
    this.name = "ClearResultsLinkedCopiesError";
    this.linkedCards = linkedCards;
    this.otherSources = otherSources;
  }
}

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
export async function clearFilterResults(filterId: string, scope: ClearResultsScope = {}, operatorId?: string): Promise<ClearResultsSummary> {
  const supabase = createAdminClient();
  await assertNoActiveFinderWork(supabase, filterId);
  const payload = await getFilterResults(filterId, false, Date.now(), operatorId);
  if (!payload) throw new Error("Nie znaleziono filtra.");
  const cutoff = typeof scope.olderThanDays === "number" && scope.olderThanDays > 0
    ? Date.now() - scope.olderThanDays * 86_400_000
    : null;
  const cards = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults]
    // Same rule as the Finder's source filter: a card belongs to every portal it links.
    .filter((result) => !scope.source || result.source === scope.source || Boolean(result.linkedListings?.some((listing) => listing.source === scope.source)))
    .filter((result) => {
      if (cutoff === null) return true;
      const lastSeen = Date.parse(result.lastSeenAt);
      return Number.isFinite(lastSeen) && lastSeen < cutoff;
    });
  // A grouped card stands for every linked portal copy; clearing only its
  // representative would bring the other copies back as a separate card.
  const sourceById = new Map<string, string>();
  for (const card of cards) {
    sourceById.set(card.id, card.source);
    for (const listing of card.linkedListings ?? []) sourceById.set(listing.id, listing.source);
  }
  const targets = [...sourceById.keys()];
  if (!targets.length) return { archivedCount: 0, bySource: {}, linkedCopiesFromOtherSources: 0 };
  const otherSources: Record<string, number> = {};
  let linkedCards = 0;
  if (scope.source) {
    for (const card of cards) {
      const members = card.linkedListings?.length ? card.linkedListings : [{ id: card.id, source: card.source }];
      const others = members.filter((listing) => listing.source !== scope.source);
      if (!others.length) continue;
      linkedCards += 1;
      for (const listing of others) otherSources[listing.source] = (otherSources[listing.source] ?? 0) + 1;
    }
    if (linkedCards > 0 && scope.includeLinkedCopies !== true) throw new ClearResultsLinkedCopiesError(linkedCards, otherSources);
  }

  // Recheck after the read/target computation. The SQL canonical RPC also
  // recognizes the per-membership tombstone below and rejects any older scan
  // observation that races this mutation.
  await assertNoActiveFinderWork(supabase, filterId);
  const clearedAt = new Date().toISOString();
  let affected = 0;
  const bySource: Record<string, number> = {};
  for (let offset = 0; offset < targets.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + WRITE_CHUNK_SIZE);
    const update = await supabase.from("listing_filter_matches")
      .update({ is_current_match: false, match_reasons: [FINDER_CLEARED_MATCH_REASON], last_matched_at: clearedAt })
      .eq("search_filter_id", filterId)
      .in("listing_id", chunk)
      .select("listing_id");
    if (update.error) throw new Error("Nie udało się wyczyścić wyników filtra.");
    const archivedIds = Array.isArray(update.data) ? (update.data as Array<{ listing_id: string }>).map((row) => row.listing_id) : chunk;
    affected += archivedIds.length;
    for (const id of archivedIds) {
      const source = sourceById.get(id) ?? "unknown";
      bySource[source] = (bySource[source] ?? 0) + 1;
    }
  }
  const linkedCopiesFromOtherSources = Object.values(otherSources).reduce((sum, count) => sum + count, 0);
  return { archivedCount: affected, bySource, linkedCopiesFromOtherSources };
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
