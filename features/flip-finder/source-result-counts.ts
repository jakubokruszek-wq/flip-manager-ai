import { LISTING_SOURCES, type ListingSource } from "./index.ts";

export type FinderSourceCount = { matched: number; review: number };
export type FinderResultCounts = {
  total: FinderSourceCount;
  bySource: Record<ListingSource, FinderSourceCount>;
};

type ResultSource = { id?: string; source: ListingSource; linkedListings?: Array<{ source: ListingSource }> };

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

  countSection(matchedResults, "matched", bySource, total);
  countSection(reviewResults, "review", bySource, total);

  return { total, bySource };
}

function countSection(results: readonly ResultSource[], bucket: "matched" | "review", bySource: Record<ListingSource, FinderSourceCount>, total: FinderSourceCount): void {
  const seenCards = new Set<string>();
  results.forEach((result, index) => {
    const cardId = result.id ?? `row-${index}`;
    if (seenCards.has(cardId)) return;
    seenCards.add(cardId);
    total[bucket] += 1;
    const representedSources = new Set([result.source, ...(result.linkedListings ?? []).map((listing) => listing.source)]);
    for (const source of representedSources) bySource[source][bucket] += 1;
  });
}
