import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  filterMatchesForFilter,
  isFilterMissing,
  reliablePricePerSqm,
  resultLocation,
  resultStatus,
  sourceDomainMatchesSource,
  sortResults,
  type CompletedScanWindow,
  type FilterResult,
} from "@/features/flip-finder/results";
import { evaluateCanonicalListingDecision } from "@/features/flip-finder/filter-evaluation";
import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import type { PropertyListing } from "@/features/properties/types/property";
import { safeFacebookDisplayLocation } from "@/features/facebook-watcher/facebook-location-quality";
import { createClient } from "@/lib/supabase/server";
import { calculateOpportunityAssessment } from "@/features/flip-finder/opportunity-score";
import type { ResaleCompRecord } from "@/features/market-intelligence/resale-comps";
import { visibleMembership } from "@/features/flip-finder/membership-reconciliation";
import { parseFacebookPriceReliability, resolveFacebookPriceReliabilityOnMetadataFailure, type FacebookPriceStatus } from "@/features/facebook-watcher/price-quality";
import { canonicalVisibilityDebug } from "@/features/flip-finder/canonical-visibility";
import { effectiveGalleryDisplayState } from "@/features/facebook-worker/gallery-state";

type Row = Record<string, unknown>;

type FilterResultsPayload = {
  filter: SearchFilter;
  results: FilterResult[];
  reviewResults: FilterResult[];
  archivedResults: FilterResult[];
  counts: {
    active: number;
    review: number;
    archived: number;
  };
  total: number;
  newMatches: number;
  lastScan: SearchFilterScan | null;
  sourceScans: SearchFilterScan[];
};

type MatchRow = {
  listingId: string;
  searchFilterId: string;
  firstMatchedAt: string;
  lastMatchedAt: string;
  matchOrigin: "scan" | "filter_recalculation" | "collector_import";
  matchReasons: string[];
  isCurrentMatch: boolean;
};

type ListingRow = Pick<
  PropertyListing,
  | "id"
  | "title"
  | "price"
  | "area"
  | "rooms"
  | "floor"
  | "buildingType"
  | "ownership"
  | "description"
  | "pricePerSqm"
  | "address"
  | "city"
  | "district"
  | "images"
  | "originalUrl"
  | "source"
  | "status"
  | "firstSeenAt"
  | "lastSeenAt"
  | "lifecycleStatus"
  | "reviewReason"
  | "missingFields"
  | "manualDecision"
  | "manualDecisionReason"
  | "archivedAt"
  | "estimatedSalePrice"
  | "estimatedProfit"
  | "estimatedRoi"
  | "flipScore"
  | "galleryStatus"
  | "galleryJobId"
  | "galleryRequestedAt"
  | "galleryCompletedAt"
  | "galleryError"
  | "galleryTotal"
  | "galleryPersistedCount"
> & {
  /**
   * Generic, source-agnostic price-trust signal for the Opportunity Engine.
   * Populated today only from Facebook's own price-quality metadata (see
   * priceReliabilityByListingId below); simply absent for any other source,
   * which the engine already treats as trusted — so OLX/Otodom scoring is
   * unaffected whether or not they ever gain this metadata.
   */
  priceReliability?: FacebookPriceStatus;
};

type SnapshotRow = {
  listingId: string;
  price: number | null;
  capturedAt: string;
  rawData: Row;
};

export async function getFilterResults(filterId: string, includeArchived = false): Promise<FilterResultsPayload | null> {
  const filter = await getSearchFilter(filterId);
  if (isFilterMissing(filter)) {
    return null;
  }

  const supabase = await createClient();
  const [matchesResult, scansResult] = await Promise.all([
    supabase
      .from("listing_filter_matches")
      .select("listing_id,search_filter_id,first_matched_at,last_matched_at,is_current_match,match_origin,match_reasons")
      .eq("search_filter_id", filterId),
    supabase
      .from("source_scans")
      .select(
        "id,scan_run_id,search_filter_id,source,status,started_at,finished_at,scanned_count,matched_count,listings_created,new_count,listings_updated,price_drop_count,warnings,error_message",
      )
      .eq("search_filter_id", filterId),
  ]);

  if (matchesResult.error || scansResult.error) {
    console.error("FLIP FINDER RESULTS ERROR:", matchesResult.error ?? scansResult.error);
    throw new Error("Nie udało się pobrać wyników filtra.");
  }

  const allMatches = filterMatchesForFilter(
    asRows(matchesResult.data)
      .map(toMatchRow)
      .filter((match): match is MatchRow => match !== null),
    filterId,
  );
  // Current MATCHED memberships and explicit REVIEW memberships are visible in
  // the Finder. Reconciled-out rows remain in the database for audit/history,
  // but must not reappear as active results.
  const visibleMatches = includeArchived ? allMatches : allMatches.filter(visibleMembership);
  // Required invariant: one canonical listing appears at most once in one
  // Finder response. listing_filter_matches has a real primary key on
  // (listing_id, search_filter_id), so a genuine duplicate row for the same
  // listing under this same filter should be structurally impossible — this
  // is a defensive, no-cost floor against a duplicate ever reaching
  // allResults.flatMap (which would otherwise mint two FilterResult objects
  // sharing one id, landing in the same bucket) if a future migration,
  // client-library quirk, or caching layer ever violated that guarantee.
  // Deduplication priority here is by canonical listing ID only — the
  // highest tier — because every row in this array is already keyed on that
  // exact canonical id by construction, never a raw pre-canonical source
  // record.
  const matches = dedupeByListingId(visibleMatches);
  const scans = asRows(scansResult.data)
    .map(toSearchFilterScan)
    .filter((scan): scan is SearchFilterScan => scan !== null);
  const lastScan = scans.reduce<SearchFilterScan | null>((current, scan) => {
    return !current || scan.startedAt > current.startedAt ? scan : current;
  }, null);
  const latestCompletedScan = scans.reduce<CompletedScanWindow | null>((current, scan) => {
    if (scan.status !== "completed" || !scan.finishedAt) {
      return current;
    }

    return !current || scan.finishedAt > current.finishedAt
      ? { startedAt: scan.startedAt, finishedAt: scan.finishedAt }
      : current;
  }, null);

  if (matches.length === 0) {
    return {
      filter,
      results: [],
      reviewResults: [],
      archivedResults: [],
      counts: { active: 0, review: 0, archived: 0 },
      total: 0,
      newMatches: 0,
      lastScan,
      sourceScans: scans,
    };
  }

  const listingIds = matches.map((match) => match.listingId);
  const lifecycleStatuses = includeArchived
    ? ["ACTIVE", "REVIEW", "STALE", "ARCHIVED", "REJECTED"]
    : ["ACTIVE", "REVIEW"];
  const listingQuery = supabase
    .from("listings")
    .select(
      "id,title,price,area,rooms,floor,building_type,ownership,description,price_per_sqm,address,city,district,images,original_url,source,status,first_seen_at,last_seen_at,lifecycle_status,review_reason,missing_fields,manual_decision,manual_decision_reason,archived_at,estimated_sale_price,estimated_profit,estimated_roi,flip_score,gallery_status,gallery_job_id,gallery_requested_at,gallery_completed_at,gallery_error,gallery_total,gallery_persisted_count",
    )
    .in("id", listingIds)
    .eq("status", "active")
    .in("lifecycle_status", lifecycleStatuses);
  const [listingsResultRaw, snapshotsResult, priceQualityResult] = await Promise.all([
    listingQuery,
    supabase
      .from("listing_snapshots")
      .select("listing_id,price,captured_at,raw_data")
      .in("listing_id", listingIds)
      .order("captured_at", { ascending: false }),
    // One extra batched query (never per-listing) for Facebook's own price-quality
    // signal. Filtered server-side to source=facebook, since only Facebook writes
    // this metadata today; OLX/Otodom simply have no rows here and are unaffected.
    supabase
      .from("listing_source_metadata")
      .select("listing_id,metadata")
      .in("listing_id", listingIds)
      .eq("source", "facebook"),
  ]);
  const priceReliabilityByListingId = new Map<string, FacebookPriceStatus>();
  // Distinguish "the query ran and this Facebook listing simply has no
  // priceQuality yet" (backward-compatible: trusted, same as before this
  // feature existed) from "the query itself failed" (must not silently
  // restore trusted-by-default scoring for Facebook, since Facebook price
  // trust has no other source of truth). Only Facebook is affected either
  // way — OLX/Otodom never depended on this query for their own trust signal.
  const priceQualityMetadataQueryFailed = Boolean(priceQualityResult.error);
  if (priceQualityMetadataQueryFailed) {
    console.error("FLIP FINDER PRICE RELIABILITY METADATA ERROR:", priceQualityResult.error);
  } else {
    for (const row of asRows(priceQualityResult.data)) {
      const listingId = nullableString(row.listing_id);
      const status = parseFacebookPriceReliability(row.metadata);
      if (listingId && status) priceReliabilityByListingId.set(listingId, status);
    }
  }

  let listingsResult: typeof listingsResultRaw = listingsResultRaw;
  if (listingsResult.error?.code === "42703") {
    listingsResult = await supabase.from("listings").select("id,title,price,area,rooms,floor,building_type,ownership,description,price_per_sqm,address,city,district,images,original_url,source,status,first_seen_at,last_seen_at") .in("id", listingIds).eq("status", "active") as typeof listingsResultRaw;
  }

  if (listingsResult.error || snapshotsResult.error) {
    console.error(
      "FLIP FINDER RESULTS LISTINGS ERROR:",
      listingsResult.error ?? snapshotsResult.error,
    );
    throw new Error("Nie udało się pobrać ofert dla filtra.");
  }

  const compsResult = await supabase
    .from("resale_comps")
    .select("id,source,external_listing_id,canonical_url,title,description,city,district,street,address,latitude,longitude,price,area_m2,price_per_m2,rooms,floor,floors,building_type,construction_year,ownership,balcony,elevator,parking,renovation_status,renovation_confidence,finish_level,listing_created_at,first_seen_at,last_seen_at,active,seller_type,fingerprint,outlier_reason,evidence")
    .eq("active", true)
    .limit(500);

  const resaleComps = compsResult.error ? [] : asRows(compsResult.data).map(toResaleCompRecord).filter((comp): comp is ResaleCompRecord => comp !== null);

  const listingsById = new Map(
    asRows(listingsResult.data)
      .map(toListingRow)
      .filter((listing): listing is ListingRow => listing !== null)
      .map((listing) => [listing.id, { ...listing, priceReliability: resolveFacebookPriceReliabilityOnMetadataFailure(listing.source, priceReliabilityByListingId.get(listing.id), priceQualityMetadataQueryFailed) }]),
  );
  const snapshotsByListingId = new Map<string, SnapshotRow[]>();

  for (const snapshot of asRows(snapshotsResult.data)
    .map(toSnapshotRow)
    .filter((entry): entry is SnapshotRow => entry !== null)) {
    const snapshots = snapshotsByListingId.get(snapshot.listingId) ?? [];
    snapshots.push(snapshot);
    snapshotsByListingId.set(snapshot.listingId, snapshots);
  }

  const allResults = matches.flatMap((match): FilterResult[] => {
    const listing = listingsById.get(match.listingId);
    if (!listing) {
      return [];
    }

    const previousPrice = previousDifferentPrice(
      snapshotsByListingId.get(listing.id) ?? [],
      listing.price,
    );
    const status = resultStatus(
      {
        firstMatchedAt: match.firstMatchedAt,
        previousPrice,
        currentPrice: listing.price,
      },
      latestCompletedScan,
    );
    const safeLocation = safeFacebookDisplayLocation(listing);
    const locationText = resultLocation(safeLocation.address, safeLocation.district, safeLocation.city);
    const filterDecision = evaluateCanonicalListingDecision(
      {
        price: listing.price,
        area: listing.area,
        pricePerSqm: reliablePricePerSqm(listing.pricePerSqm, listing.price, listing.area),
        rooms: listing.rooms,
        floor: listing.floor,
        city: safeLocation.city,
        district: safeLocation.district,
        title: listing.title,
        locationText,
        buildingType: listing.buildingType,
        ownership: listing.ownership,
      },
      filter,
    );
    const sourceConflict = !sourceDomainMatchesSource(listing.source, listing.originalUrl);
    const hardFilterReject = filterDecision.hardRejectReasons.length > 0;
    const effectiveGalleryDisplay = effectiveGalleryDisplayState(listing.galleryStatus ?? null, listing.galleryRequestedAt ?? null, listing.galleryError ?? null);
    const decisionBucket: FilterResult["decisionBucket"] = sourceConflict || hardFilterReject
      ? "REJECTED"
      : listing.manualDecision === "REJECTED" || listing.lifecycleStatus === "REJECTED"
        ? "REJECTED"
        : filterDecision.bucket;
    const expectedLifecycle = decisionBucket === "MATCHED" ? "ACTIVE" : decisionBucket === "REVIEW" ? "REVIEW" : "REJECTED";
    const persistedReview = match.matchReasons.some((reason) => reason === "review" || reason.startsWith("unknown_"));
    const consistencyMismatch = listing.lifecycleStatus !== expectedLifecycle
      || match.isCurrentMatch !== (decisionBucket === "MATCHED")
      || (decisionBucket === "REVIEW" && !persistedReview);
    const canonicalDebug = canonicalVisibilityDebug({
      listingId: listing.id,
      canonicalBucket: decisionBucket,
      lifecycleStatus: listing.lifecycleStatus ?? null,
      isCurrentMatch: match.isCurrentMatch,
      matchReasons: [...filterDecision.reasons, ...(decisionBucket === "REVIEW" ? ["review", ...filterDecision.missingFields.map((field) => `unknown_${field}`)] : [])],
      visibilityInFinder: (decisionBucket === "MATCHED" || decisionBucket === "REVIEW") && listing.status === "active" && (listing.lifecycleStatus === "ACTIVE" || listing.lifecycleStatus === "REVIEW"),
      visibilityInWatcher: listing.source === "facebook",
      reason: sourceConflict ? "source_conflict" : decisionBucket === "REJECTED" ? filterDecision.hardRejectReasons.join(",") || "rejected_by_policy" : decisionBucket === "REVIEW" ? "review_uncertainty" : "current_filter_match",
      consistencyMismatch,
    });
    const publishedAt = publishedAtFromSnapshots(snapshotsByListingId.get(listing.id) ?? []);

    return [
      {
        id: listing.id,
        title: listing.title,
        price: listing.price,
        area: listing.area,
        rooms: listing.rooms,
        floor: listing.floor,
        totalFloors: null,
        buildingType: listing.buildingType,
        ownership: listing.ownership,
        description: listing.description,
        images: listing.images,
        pricePerSqm: reliablePricePerSqm(listing.pricePerSqm, listing.price, listing.area),
        locationText,
        address: safeLocation.address,
        city: safeLocation.city,
        district: safeLocation.district,
        thumbnailUrl: listing.images[0] ?? null,
        originalUrl: listing.originalUrl,
        source: listing.source,
        sourceConflict,
        listingStatus: listing.status,
        isActive: listing.status === "active",
        publishedAt,
        firstSeenAt: listing.firstSeenAt,
        lastSeenAt: listing.lastSeenAt,
        firstMatchedAt: match.firstMatchedAt,
        lastMatchedAt: match.lastMatchedAt,
        previousPrice: status.hasPriceDrop ? previousPrice : null,
        currentPrice: listing.price,
        ...status,
        isNew: match.matchOrigin === "scan" && status.isNew,
        matchReasons: [...filterDecision.reasons, ...(filterDecision.bucket === "REVIEW" ? ["review"] : [])],
        unknownFields: filterDecision.missingFields,
        decisionBucket,
        finderStatus: canonicalDebug.finderStatus,
        canonicalDecisionDebug: canonicalDebug,
        canonicalConsistencyMismatch: consistencyMismatch,
        lifecycleStatus: listing.lifecycleStatus,
        reviewReason: listing.reviewReason,
        missingFields: listing.missingFields,
        manualDecision: listing.manualDecision,
        manualDecisionReason: listing.manualDecisionReason,
        archivedAt: listing.archivedAt,
        // Gallery timeout mission: a PENDING/RUNNING gallery no extension
        // ever claimed has no proactive reaper anywhere in this codebase
        // (unlike Finder's own source_scans) — this display-time check is
        // what stops the UI from showing "Oczekuje na pobranie galerii"
        // forever. See effectiveGalleryDisplayState's own doc comment.
        galleryStatus: effectiveGalleryDisplay.status ?? undefined,
        galleryJobId: listing.galleryJobId,
        galleryTotal: listing.galleryTotal,
        galleryPersistedCount: listing.galleryPersistedCount,
        galleryError: effectiveGalleryDisplay.error ?? undefined,
        ...opportunityFields(listing, filter, decisionBucket, resaleComps),
      },
    ];
  });
  // Duplicate-listing mission: a listing whose stored lifecycle is
  // STALE/ARCHIVED (set by some other process — aging out, a manual archive
  // action, restoration bookkeeping) can still independently satisfy the
  // CURRENT filter's live criteria (decisionBucket "MATCHED" or "REVIEW").
  // Filtering each bucket only by its own positive condition let the very
  // same canonical listing qualify for two buckets at once — proven live in
  // production: 44 real listings for one active filter appeared in both
  // reviewResults and archivedResults simultaneously. Once something is
  // archived, it must render only in the archive section, never also in the
  // active grids — so MATCHED/REVIEW membership explicitly excludes
  // archived-lifecycle listings, making the three buckets mutually
  // exclusive by construction: every listing lands in exactly one.
  const archivedLifecycle = new Set(["STALE", "ARCHIVED", "REJECTED"]);
  const isArchivedLifecycle = (result: FilterResult) => archivedLifecycle.has(result.lifecycleStatus ?? "");
  const sortedResults = sortResults(allResults.filter((result) => result.decisionBucket === "MATCHED" && !isArchivedLifecycle(result)), "newest");
  const reviewResults = sortResults(allResults.filter((result) => result.decisionBucket === "REVIEW" && !isArchivedLifecycle(result)), "newest");
  const archivedResults = includeArchived ? sortResults(allResults.filter((result) => isArchivedLifecycle(result) || result.decisionBucket === "REJECTED" || result.sourceConflict === true), "newest") : [];

  return {
    filter,
    results: sortedResults,
    reviewResults,
    archivedResults,
    counts: {
      active: sortedResults.length,
      review: reviewResults.length,
      archived: archivedResults.length,
    },
    total: sortedResults.length,
    newMatches: sortedResults.filter((result) => result.isNew).length,
    lastScan,
    sourceScans: scans,
  };
}

function dedupeByListingId(matches: MatchRow[]): MatchRow[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.listingId)) return false;
    seen.add(match.listingId);
    return true;
  });
}

function toMatchRow(row: Row): MatchRow | null {
  const listingId = nullableString(row.listing_id);
  const searchFilterId = nullableString(row.search_filter_id);
  const firstMatchedAt = nullableString(row.first_matched_at);
  const lastMatchedAt = nullableString(row.last_matched_at);
  const matchOrigin = nullableString(row.match_origin) ?? "scan";
  const matchReasons = stringArray(row.match_reasons);
  const isCurrentMatch = row.is_current_match !== false;

  return listingId && searchFilterId && firstMatchedAt && lastMatchedAt && isMatchOrigin(matchOrigin)
    ? { listingId, searchFilterId, firstMatchedAt, lastMatchedAt, matchOrigin, matchReasons, isCurrentMatch }
    : null;
}

function isMatchOrigin(value: string): value is MatchRow["matchOrigin"] {
  return value === "scan" || value === "filter_recalculation" || value === "collector_import";
}

function toListingRow(row: Row): ListingRow | null {
  const id = nullableString(row.id);
  const originalUrl = nullableString(row.original_url);
  const source = nullableString(row.source);
  const status = nullableString(row.status);
  const firstSeenAt = nullableString(row.first_seen_at);
  const lastSeenAt = nullableString(row.last_seen_at);

  if (
    !id ||
    !originalUrl ||
    !isListingSource(source) ||
    !isListingStatus(status) ||
    !firstSeenAt ||
    !lastSeenAt
  ) {
    return null;
  }

  return {
    id,
    title: nullableString(row.title),
    price: nullableNumber(row.price),
    area: nullableNumber(row.area),
    rooms: nullableNumber(row.rooms),
    floor: nullableString(row.floor),
    buildingType: nullableString(row.building_type),
    ownership: nullableString(row.ownership),
    description: nullableString(row.description),
    pricePerSqm: nullableNumber(row.price_per_sqm),
    address: nullableString(row.address),
    city: nullableString(row.city),
    district: nullableString(row.district),
    images: stringArray(row.images),
    originalUrl,
    source,
    status,
    firstSeenAt,
    lastSeenAt,
    lifecycleStatus: nullableLifecycle(row.lifecycle_status),
    reviewReason: nullableString(row.review_reason),
    missingFields: stringArray(row.missing_fields),
    manualDecision: row.manual_decision === "ACCEPTED" || row.manual_decision === "REJECTED" ? row.manual_decision : null,
    manualDecisionReason: nullableString(row.manual_decision_reason),
    archivedAt: nullableString(row.archived_at),
    galleryStatus: nullableGalleryStatus(row.gallery_status),
    galleryJobId: nullableString(row.gallery_job_id),
    galleryRequestedAt: nullableString(row.gallery_requested_at),
    galleryCompletedAt: nullableString(row.gallery_completed_at),
    galleryError: nullableString(row.gallery_error),
    galleryTotal: nonnegativeNumber(row.gallery_total),
    galleryPersistedCount: nonnegativeNumber(row.gallery_persisted_count),
    estimatedSalePrice: nullableNumber(row.estimated_sale_price),
    estimatedProfit: nullableNumber(row.estimated_profit),
    estimatedRoi: nullableNumber(row.estimated_roi),
    flipScore: nullableNumber(row.flip_score),
  };
}

function opportunityFields(
  listing: ListingRow,
  filter: SearchFilter,
  decisionBucket: "MATCHED" | "REVIEW" | "REJECTED",
  comps: ResaleCompRecord[],
): Pick<FilterResult, "opportunityScore" | "opportunityPriority" | "economicsConfidence" | "arvConfidence" | "dataConfidence" | "compCount" | "conservativeArv" | "expectedArv" | "optimisticArv" | "grossSpread" | "estimatedRenovationCost" | "estimatedProfit" | "estimatedRoi" | "marketDiscountPct" | "opportunityMissingFields" | "underwriting"> {
  const assessment = calculateOpportunityAssessment({
    id: listing.id,
    source: listing.source,
    sourceUrl: listing.originalUrl,
    lifecycleStatus: listing.lifecycleStatus,
    decisionBucket,
    manualDecision: listing.manualDecision,
    price: listing.price,
    area: listing.area,
    rooms: listing.rooms,
    pricePerSqm: reliablePricePerSqm(listing.pricePerSqm, listing.price, listing.area),
    city: listing.city,
    district: listing.district,
    address: listing.address,
    buildingType: listing.buildingType,
    ownership: listing.ownership,
    galleryAvailable: listing.images.length > 0,
    floor: listing.floor,
    title: listing.title,
    description: listing.description,
    missingFields: listing.missingFields ?? [],
    lastSeenAt: listing.lastSeenAt,
    priceReliability: listing.priceReliability,
  }, filter, comps);
  return assessment ? {
    opportunityScore: assessment.score,
    opportunityPriority: assessment.priority,
    economicsConfidence: assessment.economicsConfidence,
    arvConfidence: assessment.arvConfidence,
    dataConfidence: assessment.dataConfidence,
    compCount: assessment.compCount,
    conservativeArv: assessment.conservativeArv,
    expectedArv: assessment.expectedArv,
    optimisticArv: assessment.optimisticArv,
    grossSpread: assessment.grossSpread,
    estimatedRenovationCost: assessment.estimatedRenovationCost,
    estimatedProfit: assessment.estimatedProfit,
    estimatedRoi: assessment.estimatedRoi,
    marketDiscountPct: assessment.marketDiscountPct,
    opportunityMissingFields: assessment.missingFields,
    underwriting: assessment.underwriting,
  } : {
    opportunityScore: null,
    opportunityPriority: null,
    economicsConfidence: null,
    arvConfidence: null,
    dataConfidence: null,
    compCount: 0,
    conservativeArv: null,
    expectedArv: null,
    optimisticArv: null,
    grossSpread: null,
    estimatedRenovationCost: null,
    estimatedProfit: null,
    estimatedRoi: null,
    marketDiscountPct: null,
    opportunityMissingFields: [],
    underwriting: null,
  };
}

function toResaleCompRecord(row: Row): ResaleCompRecord | null {
  const id = nullableString(row.id);
  const source = nullableString(row.source);
  const externalListingId = nullableString(row.external_listing_id);
  const lastSeenAt = nullableString(row.last_seen_at);
  const renovationStatus = row.renovation_status;
  const renovationConfidence = row.renovation_confidence;
  if (!id || !externalListingId || !lastSeenAt || !isResaleCompSource(source) || !isRenovationStatus(renovationStatus) || !isRenovationConfidence(renovationConfidence)) return null;
  const evidence = isRow(row.evidence) ? stringArray(row.evidence.signals) : [];
  return {
    id,
    source,
    externalListingId,
    canonicalUrl: nullableString(row.canonical_url),
    title: nullableString(row.title),
    description: nullableString(row.description),
    city: nullableString(row.city),
    district: nullableString(row.district),
    street: nullableString(row.street),
    address: nullableString(row.address),
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude),
    price: nullableNumber(row.price),
    areaM2: nullableNumber(row.area_m2),
    pricePerM2: nullableNumber(row.price_per_m2),
    rooms: nullableNumber(row.rooms),
    floor: nullableString(row.floor),
    floors: nullableString(row.floors),
    buildingType: nullableString(row.building_type),
    constructionYear: nullableNumber(row.construction_year),
    ownership: nullableString(row.ownership),
    balcony: row.balcony === true ? true : row.balcony === false ? false : null,
    elevator: row.elevator === true ? true : row.elevator === false ? false : null,
    parking: row.parking === true ? true : row.parking === false ? false : null,
    listingCreatedAt: nullableString(row.listing_created_at),
    firstSeenAt: nullableString(row.first_seen_at) ?? lastSeenAt,
    lastSeenAt,
    active: row.active === true,
    sellerType: nullableString(row.seller_type),
    fingerprint: nullableString(row.fingerprint),
    classification: {
      isCandidate: true,
      renovationStatus,
      renovationConfidence,
      finishLevel: nullableString(row.finish_level),
      evidence,
      outlierReason: nullableString(row.outlier_reason),
      exclusionReason: null,
    },
  };
}

function isResaleCompSource(value: string | null): value is ResaleCompRecord["source"] {
  return value === "facebook" || value === "otodom" || value === "olx" || value === "morizon";
}

function isRenovationStatus(value: unknown): value is ResaleCompRecord["classification"]["renovationStatus"] {
  return value === "RENOVATED" || value === "MOVE_IN_READY" || value === "REFRESHED" || value === "UNKNOWN";
}

function isRenovationConfidence(value: unknown): value is ResaleCompRecord["classification"]["renovationConfidence"] {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

function nullableLifecycle(value: unknown): PropertyListing["lifecycleStatus"] {
  return value === "ACTIVE" || value === "REVIEW" || value === "STALE" || value === "ARCHIVED" || value === "REJECTED" ? value : "ACTIVE";
}

function nullableGalleryStatus(value: unknown): NonNullable<PropertyListing["galleryStatus"]> {
  return value === "PENDING" || value === "RUNNING" || value === "PARTIAL" || value === "COMPLETE" || value === "FAILED" ? value : "NOT_REQUESTED";
}

function toSnapshotRow(row: Row): SnapshotRow | null {
  const listingId = nullableString(row.listing_id);
  const capturedAt = nullableString(row.captured_at);

  return listingId && capturedAt
    ? {
        listingId,
        price: nullableNumber(row.price),
        capturedAt,
        rawData: isRow(row.raw_data) ? row.raw_data : {},
      }
    : null;
}

function toSearchFilterScan(row: Row): SearchFilterScan | null {
  const id = nullableString(row.id);
  const searchFilterId = nullableString(row.search_filter_id);
  const source = nullableString(row.source);
  const status = nullableString(row.status);
  const startedAt = nullableString(row.started_at);

  if (
    !id ||
    !searchFilterId ||
    !isListingSource(source) ||
    !isSearchFilterScanStatus(status) ||
    !startedAt
  ) {
    return null;
  }

  const errorMessage = nullableString(row.error_message);

  return {
    id,
    scanRunId: nullableString(row.scan_run_id),
    searchFilterId,
    source,
    status,
    startedAt,
    finishedAt: nullableString(row.finished_at),
    scannedCount: nonnegativeNumber(row.scanned_count),
    matchedCount: nonnegativeNumber(row.matched_count),
    listingsCreated: nonnegativeNumber(row.listings_created),
    newCount: nonnegativeNumber(row.new_count),
    listingsUpdated: nonnegativeNumber(row.listings_updated),
    priceDropCount: nonnegativeNumber(row.price_drop_count),
    warningsCount: Array.isArray(row.warnings) ? row.warnings.length : 0,
    errorsCount: errorMessage ? 1 : 0,
    errorMessage,
  };
}

function previousDifferentPrice(snapshots: SnapshotRow[], currentPrice: number | null): number | null {
  if (currentPrice === null) {
    return null;
  }

  for (const snapshot of snapshots) {
    if (snapshot.price !== null && snapshot.price !== currentPrice) {
      return snapshot.price;
    }
  }

  return null;
}

function publishedAtFromSnapshots(snapshots: SnapshotRow[]): string | null {
  for (const snapshot of snapshots) {
    const publishedAt = rawPublishedAt(snapshot.rawData);
    if (publishedAt) return publishedAt;
  }
  return null;
}

function rawPublishedAt(raw: Row): string | null {
  for (const key of ["publishedAt", "published_at", "createdAt", "created_at", "createdTime", "creation_time", "postedAt", "posted_at"]) {
    const parsed = validIsoDate(raw[key]);
    if (parsed) return parsed;
  }
  return null;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}



function validIsoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(new Date(milliseconds).getTime()) ? new Date(milliseconds).toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isListingSource(value: string | null): value is FilterResult["source"] {
  return value === "otodom" || value === "olx" || value === "morizon" || value === "facebook";
}

function isListingStatus(value: string | null): value is FilterResult["listingStatus"] {
  return value === "active" || value === "removed" || value === "sold" || value === "watched";
}

function isSearchFilterScanStatus(
  value: string | null,
): value is SearchFilterScan["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "partial"
  );
}
