import { evaluateListingAgainstFilter, type FilterCandidate } from "@/features/flip-finder/filter-evaluation";
import type { ListingSource, SearchFilter } from "@/features/flip-finder";

export type RecalculationListing = FilterCandidate & {
  id: string;
  source: ListingSource;
  originalUrl: string;
};

export type RecalculationMatch = { listingId: string };

export type FilterRecalculationPlan = {
  evaluated: number;
  matchesBefore: number;
  addedListingIds: string[];
  removedListingIds: string[];
  unchangedListingIds: string[];
  matchesAfter: number;
  rejectedByPricePerSqm: number;
  rejectedByOtherCriteria: number;
  maxPricePerSqmBefore: number | null;
  maxPricePerSqmAfter: number | null;
};

export function planFilterMatchRecalculation(
  filter: SearchFilter,
  listings: RecalculationListing[],
  matches: RecalculationMatch[],
): FilterRecalculationPlan {
  const listingsById = new Map(listings.map((listing) => [listing.id, listing]));
  const existingIds = new Set(matches.map((match) => match.listingId));
  const addedListingIds: string[] = [];
  const removedIds = new Set<string>();
  const unchangedListingIds: string[] = [];
  const keptListings: RecalculationListing[] = [];
  let evaluated = 0;
  let rejectedByPricePerSqm = 0;
  let rejectedByOtherCriteria = 0;

  for (const listing of listings) {
    if (!filter.sources.includes(listing.source)) {
      if (existingIds.has(listing.id)) {
        removedIds.add(listing.id);
      }
      continue;
    }

    evaluated += 1;
    const decision = evaluateListingAgainstFilter(listing, filter);
    const categoryPage = isMorizonCategoryPage(listing);
    const matchesCurrentFilter = decision.matches && !categoryPage;

    if (matchesCurrentFilter) {
      keptListings.push(listing);
      if (existingIds.has(listing.id)) {
        unchangedListingIds.push(listing.id);
      } else {
        addedListingIds.push(listing.id);
      }
      continue;
    }

    if (decision.reasons.includes("max_price_per_sqm")) {
      rejectedByPricePerSqm += 1;
    } else {
      rejectedByOtherCriteria += 1;
    }

    if (existingIds.has(listing.id)) {
      removedIds.add(listing.id);
    }
  }

  for (const listingId of existingIds) {
    if (!listingsById.has(listingId)) {
      removedIds.add(listingId);
    }
  }

  return {
    evaluated,
    matchesBefore: matches.length,
    addedListingIds,
    removedListingIds: [...removedIds],
    unchangedListingIds,
    matchesAfter: matches.length - removedIds.size + addedListingIds.length,
    rejectedByPricePerSqm,
    rejectedByOtherCriteria,
    maxPricePerSqmBefore: maximumPricePerSqm(
      matches
        .map((match) => listingsById.get(match.listingId))
        .filter((listing): listing is RecalculationListing => listing !== undefined),
    ),
    maxPricePerSqmAfter: maximumPricePerSqm(keptListings),
  };
}

function isMorizonCategoryPage(listing: RecalculationListing): boolean {
  return (
    listing.source === "morizon" &&
    listing.title?.trim().toLocaleLowerCase("pl-PL") === "mieszkania na sprzedaż łódź" &&
    /morizon\.pl\/mieszkania\/[^/?#]+\/?$/i.test(listing.originalUrl)
  );
}

function maximumPricePerSqm(listings: RecalculationListing[]): number | null {
  const values = listings.flatMap((listing) => {
    const { price, area } = listing;
    return price !== null && area !== null && Number.isFinite(price) && Number.isFinite(area) && price > 0 && area > 0
      ? [price / area]
      : [];
  });

  return values.length === 0 ? null : Math.max(...values);
}
