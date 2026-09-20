import type { CanonicalListingDecision } from "./filter-evaluation.ts";

export type FinderStatus = "MATCHED" | "REVIEW" | "REJECTED" | "HISTORICAL";

export type CanonicalVisibilityDebug = {
  listingId: string;
  canonicalBucket: CanonicalListingDecision["bucket"];
  lifecycleStatus: string | null;
  isCurrentMatch: boolean;
  matchReasons: string[];
  visibilityInFinder: boolean;
  visibilityInWatcher: boolean;
  finderStatus: FinderStatus;
  reason: string;
  consistencyMismatch?: boolean;
};

export function canonicalVisibilityDebug(input: Omit<CanonicalVisibilityDebug, "finderStatus"> & { finderStatus?: FinderStatus }): CanonicalVisibilityDebug {
  const historical = input.lifecycleStatus === "ARCHIVED" || input.lifecycleStatus === "STALE";
  return {
    ...input,
    finderStatus: input.finderStatus ?? (historical ? "HISTORICAL" : input.canonicalBucket),
  };
}

export function summarizeCanonicalVisibility(rows: CanonicalVisibilityDebug[]): { totalWatcher: number; matched: number; review: number; rejected: number; historical: number } {
  return rows.reduce((summary, row) => {
    summary.totalWatcher += row.visibilityInWatcher ? 1 : 0;
    if (row.finderStatus === "MATCHED") summary.matched += 1;
    else if (row.finderStatus === "REVIEW") summary.review += 1;
    else if (row.finderStatus === "REJECTED") summary.rejected += 1;
    else summary.historical += 1;
    return summary;
  }, { totalWatcher: 0, matched: 0, review: 0, rejected: 0, historical: 0 });
}
