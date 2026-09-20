export type FacebookFinderStatus = "MATCHED" | "REVIEW" | "REJECTED" | "HISTORICAL";
export type FacebookLifecycleStatus = "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED";

export type ListingStatusPresentation =
  | { mode: "unified"; label: FacebookFinderStatus }
  | { mode: "distinct"; finderLabel: FacebookFinderStatus; lifecycleLabel: FacebookLifecycleStatus }
  | { mode: "finder-only"; label: FacebookFinderStatus };

/**
 * Which lifecycle values communicate the SAME real-world state as a given
 * Finder decision. HISTORICAL is itself derived from lifecycleStatus being
 * ARCHIVED or STALE (see canonicalVisibilityDebug), so both count as "same".
 */
const FINDER_LIFECYCLE_EQUIVALENCE: Record<FacebookFinderStatus, ReadonlySet<FacebookLifecycleStatus>> = {
  MATCHED: new Set(["ACTIVE"]),
  REVIEW: new Set(["REVIEW"]),
  REJECTED: new Set(["REJECTED"]),
  HISTORICAL: new Set(["ARCHIVED", "STALE"]),
};

/**
 * Decides whether a listing's canonical Finder decision and its Watcher
 * lifecycle status communicate the same real-world state (show it once) or
 * materially differ (show both, since disagreement is diagnostically
 * important and must never be hidden). When the lifecycle status is unknown
 * there is nothing to compare it against, so the Finder status is shown
 * alone rather than guessing at agreement.
 */
export function resolveListingStatusPresentation(input: { finderStatus: FacebookFinderStatus; lifecycleStatus: FacebookLifecycleStatus | null | undefined }): ListingStatusPresentation {
  if (!input.lifecycleStatus) return { mode: "finder-only", label: input.finderStatus };
  const same = FINDER_LIFECYCLE_EQUIVALENCE[input.finderStatus].has(input.lifecycleStatus);
  return same ? { mode: "unified", label: input.finderStatus } : { mode: "distinct", finderLabel: input.finderStatus, lifecycleLabel: input.lifecycleStatus };
}
