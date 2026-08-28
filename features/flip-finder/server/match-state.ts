export function staleListingFilterMatchKey(listingId: string, searchFilterId: string): { listingId: string; searchFilterId: string } {
  return { listingId, searchFilterId };
}

export function staleListingFilterMatchValues(): { is_current_match: false } {
  return { is_current_match: false };
}
