import type { ListingSource } from "@/features/flip-finder";

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
