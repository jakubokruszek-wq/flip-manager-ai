import { LISTING_SOURCES, type ListingSource } from "./index.ts";

export type FinderSourceCount = { matched: number; review: number };
export type FinderResultCounts = {
  total: FinderSourceCount;
  bySource: Record<ListingSource, FinderSourceCount>;
};

type ResultSource = { source: ListingSource };

/**
 * Counts the canonical, already-filtered cards returned by Finder's read path.
 * `results` and `reviewResults` are separate card sections, so keep their
 * counts separate and derive the total from those same rows rather than scan
 * or import telemetry.
 */
export function countFinderResultsBySource(
  matchedResults: readonly ResultSource[],
  reviewResults: readonly ResultSource[],
): FinderResultCounts {
  const bySource = Object.fromEntries(
    LISTING_SOURCES.map((source) => [source, { matched: 0, review: 0 }]),
  ) as Record<ListingSource, FinderSourceCount>;
  const total = { matched: 0, review: 0 };

  for (const result of matchedResults) {
    bySource[result.source].matched += 1;
    total.matched += 1;
  }
  for (const result of reviewResults) {
    bySource[result.source].review += 1;
    total.review += 1;
  }

  return { total, bySource };
}
