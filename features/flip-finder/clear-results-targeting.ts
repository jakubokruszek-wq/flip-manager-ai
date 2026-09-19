import type { ListingSource } from "@/features/flip-finder";
import { visibleMembership } from "./membership-reconciliation.ts";

export type ClearResultsMatch = { listingId: string; isCurrentMatch: boolean; matchReasons: string[] };

/**
 * Which listing ids are currently visible in the Finder for a filter, from its
 * raw listing_filter_matches rows. `is_current_match` alone is NOT the same
 * thing: a REVIEW-bucket listing (shown in the "Do oceny" tab) is intentionally
 * persisted with is_current_match=false, so filtering on that flag alone
 * silently drops every REVIEW result — exactly the state a filter is in
 * whenever nothing has fully matched a filter's hard conditions yet. This must
 * reuse the Finder's own visibility rule (visibleMembership), never a
 * narrower, independently-maintained approximation of it.
 */
export function selectVisibleListingIds(matches: readonly ClearResultsMatch[]): string[] {
  const visible = matches.filter((match) => visibleMembership({ isCurrentMatch: match.isCurrentMatch, matchReasons: match.matchReasons }));
  return [...new Set(visible.map((match) => match.listingId))];
}

/** Only these lifecycle states are visible in the active Finder view; anything else is already hidden. */
export const CLEARABLE_LIFECYCLE_STATUSES = ["ACTIVE", "REVIEW"] as const;

export type ClearResultsScope = {
  source?: ListingSource;
  /** Only listings not seen in this many days or more. Omit to clear regardless of age. */
  olderThanDays?: number;
};

export type ClearableListing = {
  id: string;
  source: ListingSource;
  lifecycleStatus: string | null;
  lastSeenAt: string | null;
};

/**
 * Pure decision logic for "Wyczyść wyniki": which currently-visible listings a
 * given scope selects for archiving. Kept free of any DB import so the exact
 * targeting rules can be tested directly, matching the scope filters actually
 * offered by the API (source, or a "not seen in N days" staleness cutoff).
 */
export function selectClearResultsTargets(listings: readonly ClearableListing[], scope: ClearResultsScope, now: number): string[] {
  const cutoff = typeof scope.olderThanDays === "number" && scope.olderThanDays > 0 ? now - scope.olderThanDays * 86_400_000 : null;
  return listings
    .filter((listing) => (CLEARABLE_LIFECYCLE_STATUSES as readonly string[]).includes(listing.lifecycleStatus ?? ""))
    .filter((listing) => !scope.source || listing.source === scope.source)
    .filter((listing) => {
      if (cutoff === null) return true;
      const lastSeenMs = listing.lastSeenAt ? Date.parse(listing.lastSeenAt) : Number.NaN;
      return Number.isFinite(lastSeenMs) && lastSeenMs < cutoff;
    })
    .map((listing) => listing.id);
}
