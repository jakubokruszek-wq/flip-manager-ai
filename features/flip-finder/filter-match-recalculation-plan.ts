import { evaluateListingAgainstFilter, type FilterCandidate } from "@/features/flip-finder/filter-evaluation";
import type { ListingSource, SearchFilter } from "@/features/flip-finder";

export type RecalculationListing = FilterCandidate & {
  id: string;
  source: ListingSource;
  originalUrl: string;
  manualDecision?: "ACCEPTED" | "REJECTED" | null;
  lifecycleStatus?: "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED" | null;
};

export type RecalculationMatch = {
  listingId: string;
  isCurrentMatch?: boolean;
  matchReasons?: string[];
};

/**
 * The real, fresh reason a removed listing no longer belongs to the filter's
 * current matches -- carried through so the caller can persist the actual
 * bucket (REJECTED vs REVIEW) and specific reasons/missingFields, instead of
 * collapsing every removal into the same generic "REJECTED" with no real
 * explanation. A listing missing required data must become REVIEW here, not
 * REJECTED -- matching exactly what a fresh evaluation of the same listing
 * would produce for a brand-new scan.
 */
export type RemovedListingDecision = {
  listingId: string;
  bucket: "REJECTED" | "REVIEW";
  reasons: string[];
  missingFields: string[];
};

export type FilterRecalculationPlan = {
  evaluated: number;
  matchesBefore: number;
  addedListingIds: string[];
  removedListingIds: string[];
  removedListingDecisions: RemovedListingDecision[];
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
  const existingIds = new Set(
    matches
      .filter((match) => match.isCurrentMatch !== false || (match.matchReasons ?? []).some((reason) => reason === "review" || reason.startsWith("unknown_")))
      .map((match) => match.listingId),
  );
  const addedListingIds: string[] = [];
  const removedIds = new Set<string>();
  const removedDecisions = new Map<string, RemovedListingDecision>();
  const unchangedListingIds: string[] = [];
  const keptListings: RecalculationListing[] = [];
  let evaluated = 0;
  let rejectedByPricePerSqm = 0;
  let rejectedByOtherCriteria = 0;
  const markRemoved = (listingId: string, decision: RemovedListingDecision) => {
    removedIds.add(listingId);
    removedDecisions.set(listingId, decision);
  };

  for (const listing of listings) {
    if (!filter.sources.includes(listing.source)) {
      if (existingIds.has(listing.id)) {
        markRemoved(listing.id, { listingId: listing.id, bucket: "REJECTED", reasons: ["source_not_in_filter"], missingFields: [] });
      }
      continue;
    }

    evaluated += 1;
    // manualDecision "REJECTED" is a deliberate, permanent operator decision
    // (features/flip-finder's review RPC only ever sets it from an explicit
    // operator action) and ARCHIVED requires an explicit restore action --
    // both are genuinely sticky. lifecycleStatus "REJECTED" on its own is
    // NOT: it is also the value this very recalculation writes onto
    // public.listings (a single, cross-filter column) whenever a listing
    // fails ANY filter's criteria. Treating a bare "REJECTED" lifecycle as
    // permanent made that self-perpetuating -- once any filter rejected a
    // listing, no later recalculation (even the same filter after loosening
    // its own thresholds) would ever evaluate it again. Real production
    // case: filter "Flip" raised max_price_per_sqm to 7300, but 148/154
    // Facebook listings stayed stuck REJECTED with
    // match_reasons=["reconciled_out","complete_scan_filter_mismatch"]
    // forever, including offers well under the new cap.
    const permanentlyExcluded = listing.manualDecision === "REJECTED" || listing.lifecycleStatus === "ARCHIVED";
    if (permanentlyExcluded) {
      if (existingIds.has(listing.id)) {
        markRemoved(listing.id, {
          listingId: listing.id,
          bucket: "REJECTED",
          reasons: [listing.manualDecision === "REJECTED" ? "manual_rejected" : "archived"],
          missingFields: [],
        });
      }
      continue;
    }
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
      // A listing that no longer matches is not automatically "rejected":
      // missing required data (no reasons, only unknownFields) is REVIEW per
      // this same contract's decisionBucket(), never a silent accept and
      // never a REJECTED masquerading as a data gap. categoryPage (a Morizon
      // listing-collection page masquerading as one listing) has no filter-
      // evaluation reasons of its own, so it is reported as a real, specific
      // rejection rather than an empty one.
      const bucket: RemovedListingDecision["bucket"] = categoryPage || decision.bucket === "REJECTED" ? "REJECTED" : "REVIEW";
      const reasons = categoryPage && decision.reasons.length === 0 ? ["category_page"] : decision.reasons;
      markRemoved(listing.id, { listingId: listing.id, bucket, reasons, missingFields: decision.unknownFields });
    }
  }

  for (const listingId of existingIds) {
    if (!listingsById.has(listingId)) {
      markRemoved(listingId, { listingId, bucket: "REJECTED", reasons: ["listing_missing"], missingFields: [] });
    }
  }

  return {
    evaluated,
    matchesBefore: existingIds.size,
    addedListingIds,
    removedListingIds: [...removedIds],
    removedListingDecisions: [...removedDecisions.values()],
    unchangedListingIds,
    matchesAfter: existingIds.size - removedIds.size + addedListingIds.length,
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
