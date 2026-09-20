export type FacebookHistoryCandidate = {
  listingId: string;
  crossSourceMatch?: boolean;
  linkedProperty?: boolean;
  linkedDeal?: boolean;
};

export type FacebookHistoryPlan = {
  pureFacebookListingIds: string[];
  preservedListingIds: string[];
  removedAssociationListingIds: string[];
};

export function planFacebookWatcherHistoryClear(candidates: FacebookHistoryCandidate[]): FacebookHistoryPlan {
  const pureFacebookListingIds: string[] = [];
  const preservedListingIds: string[] = [];
  for (const candidate of candidates) {
    const preserve = candidate.crossSourceMatch === true || candidate.linkedProperty === true || candidate.linkedDeal === true;
    (preserve ? preservedListingIds : pureFacebookListingIds).push(candidate.listingId);
  }
  return { pureFacebookListingIds, preservedListingIds, removedAssociationListingIds: [...preservedListingIds] };
}
