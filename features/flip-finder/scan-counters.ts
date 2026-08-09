export type ScanItemCounts = {
  listingsCreatedCount: number;
  newMatchesCount: number;
};

type ScanItemOutcome = {
  listingCreated: boolean;
  matchCreated: boolean;
};

export function addScanItemCounts(
  counts: ScanItemCounts,
  outcome: ScanItemOutcome,
): ScanItemCounts {
  return {
    listingsCreatedCount: counts.listingsCreatedCount + (outcome.listingCreated ? 1 : 0),
    newMatchesCount: counts.newMatchesCount + (outcome.matchCreated ? 1 : 0),
  };
}
