import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
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
import { isListingSource as isKnownListingSource, type SearchFilterScan } from "@/features/flip-finder/search-filter-contract";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { isStaleScan, scanHeartbeatAt, STALE_SCAN_MESSAGE } from "@/features/flip-finder/server/scan-lifecycle";
import type { PropertyListing } from "@/features/properties/types/property";
import { safeFacebookDisplayLocation } from "@/features/facebook-watcher/facebook-location-quality";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateOpportunityAssessment } from "@/features/flip-finder/opportunity-score";
import type { ResaleCompRecord } from "@/features/market-intelligence/resale-comps";
import { reviewMembership, visibleMembership } from "@/features/flip-finder/membership-reconciliation";
import { parseFacebookPriceReliability, resolveFacebookPriceReliabilityOnMetadataFailure, type FacebookPriceStatus } from "@/features/facebook-watcher/price-quality";
import { canonicalVisibilityDebug } from "@/features/flip-finder/canonical-visibility";
import { effectiveGalleryDisplayState } from "@/features/facebook-worker/gallery-state";
import { resolveListingUrl } from "@/features/listing-url";
import { canonicalFacebookContentFingerprint, canonicalFacebookParameterFingerprint, normalizeListingIdentityUrl } from "@/features/listing-identity";
import { earliestPublicationDate, latestPublicationDate, listingFreshness, normalizePublicationDate } from "@/features/flip-finder/publication-date";
import { isValidSalePrice } from "@/features/flip-finder/sale-price";
import { resolveBuildingType } from "@/features/flip-finder/listing-attribute-extraction";
import { identityPairKey, type PropertyIdentityGroupOptions } from "@/features/flip-finder/property-identity";
import { normalizeListingIdentityEvidence } from "@/features/flip-finder/identity-evidence";
import { partitionFinderRows, sectionForDecision, toExcludedResult, type FinderExcludedResult, type FinderExclusionCode, type FinderRow } from "@/features/flip-finder/finder-sections";
import { FINDER_REVIEW_MEMBERSHIP_OR_FILTER, ARCHIVE_PAGE_SIZE_DEFAULT, ARCHIVE_PAGE_SIZE_MAX, SOURCE_SCAN_READ_LIMIT, RESALE_COMPS_CACHE_TTL_MS } from "@/features/flip-finder/finder-read-policy";
import { readBuildingTypeConfirmations } from "@/features/flip-finder/server/building-type-confirmations";

type Row = Record<string, unknown>;

export type FinderView = "active" | "archive";

export type FilterResultsOptions = {
  /** Archive memberships (historical/rejected/cleared) are read only for this view, one server-side page at a time. */
  view?: FinderView;
  archiveOffset?: number;
  archiveLimit?: number;
  /**
   * Dashboard counters only: skips price snapshots, resale comps and the
   * opportunity engine, which never change which section a listing lands in.
   */
  summaryOnly?: boolean;
  /** Read-only diagnostics: observe pair assessments or compare with explicit-identity-only grouping. */
  identity?: Pick<PropertyIdentityGroupOptions, "crossPortalEvidence" | "onPairAssessed">;
};

export type FinderReadDiagnostics = {
  view: FinderView;
  queryCount: number;
  membershipRowsRead: number;
  listingRowsRead: number;
  snapshotRowsRead: number;
  sourceScanRowsRead: number;
  durationMs: number;
};

export type FilterResultsPayload = {
  filter: SearchFilter;
  results: FilterResult[];
  reviewResults: FilterResult[];
  /** REVIEW listings whose building type is not confirmed: never mixed into Dopasowane / Do oceny. */
  buildingVerificationResults: FilterResult[];
  /** Current memberships that are not shown in any section, each with an explicit reason. */
  excludedResults: FinderExcludedResult[];
  /** Only populated for view=archive, one page at a time. */
  archivedResults: FilterResult[];
  archive: { offset: number; limit: number; total: number; hasMore: boolean } | null;
  counts: {
    active: number;
    review: number;
    buildingVerification: number;
    excluded: number;
    archived: number;
  };
  total: number;
  newMatches: number;
  lastScan: SearchFilterScan | null;
  sourceScans: SearchFilterScan[];
  identityFeatures: { automaticEvidenceAvailable: boolean; manualReviewAvailable: boolean; buildingConfirmationAvailable: boolean };
  diagnostics: FinderReadDiagnostics;
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
  /** The persisted structured value, before read-time reconciliation with the listing text. */
  rawBuildingType?: unknown;
  externalListingId?: string | null;
  contentHash?: string | null;
  crossSourceIdentity?: string | null;
  identityEvidence?: import("@/features/flip-finder/identity-evidence").ListingIdentityEvidence;
  contentFingerprint?: string | null;
  parameterFingerprint?: string | null;
  facebookPostId?: string | null;
  listingIntent?: string | null;
  yearBuilt?: number | null;
  sourceMetadataCollectedAt?: string | null;
  sourcePostUrl?: string | null;
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
  publishedCandidates: unknown[];
};

type SupabaseSession = Awaited<ReturnType<typeof createClient>>;

// Typed as plain string: PostgREST JSON-path aliases are not useful to the
// generated select-string type parser and only slow type checking down.
const SOURCE_SCAN_COLUMNS: string = "id,scan_run_id,search_filter_id,source,status,started_at,finished_at,scanned_count,matched_count,listings_created,new_count,listings_updated,price_drop_count,warnings,error_message,scan_progress:filter_snapshot->_scanProgress";

/**
 * Finder read path. Production (2026-10-13) had 3854 memberships for filter
 * "Flip" but only 4 current matches and 87 REVIEW rows; the previous version
 * read every membership, every scan of the filter, full snapshot JSON and
 * 500 comps on each open (and the dashboard did it once more per filter).
 * The active view now reads only current MATCHED + explicit REVIEW
 * memberships; history is paged from the archive view on demand.
 */
export async function getFilterResults(
  filterId: string,
  includeArchived = false,
  now = Date.now(),
  operatorId?: string,
  options: FilterResultsOptions = {},
): Promise<FilterResultsPayload | null> {
  const startedAt = Date.now();
  const view: FinderView = includeArchived || options.view === "archive" ? "archive" : "active";
  const summaryOnly = options.summaryOnly === true && view === "active";
  const stats = { queryCount: 0, membershipRowsRead: 0, listingRowsRead: 0, snapshotRowsRead: 0, sourceScanRowsRead: 0 };
  const session = await createClient();
  // Every .from() call is one PostgREST round trip (pagination calls .from()
  // again per page), so counting here measures the real number of queries.
  const supabase = { from: (table: string) => { stats.queryCount += 1; return session.from(table); } } as SupabaseSession;
  let adminClient: ReturnType<typeof createAdminClient> | null = null;
  const getAdminClient = () => (adminClient ??= createAdminClient());

  stats.queryCount += 1;
  const archiveLimit = clampInteger(options.archiveLimit, 1, ARCHIVE_PAGE_SIZE_MAX, ARCHIVE_PAGE_SIZE_DEFAULT);
  const archiveOffset = clampInteger(options.archiveOffset, 0, Number.MAX_SAFE_INTEGER, 0);
  const [filter, membershipResult, scansResult, archivedCountResult, comps] = await Promise.all([
    getSearchFilter(filterId),
    view === "active"
      ? readVisibleMemberships(supabase, filterId)
      : supabase
        .from("listing_filter_matches")
        .select("listing_id,search_filter_id,first_matched_at,last_matched_at,is_current_match,match_origin,match_reasons", { count: "exact" })
        .eq("search_filter_id", filterId)
        .eq("is_current_match", false)
        .not("match_reasons", "cs", '["review"]')
        .order("last_matched_at", { ascending: false })
        .order("listing_id", { ascending: true })
        .range(archiveOffset, archiveOffset + archiveLimit - 1),
    supabase
      .from("source_scans")
      .select(SOURCE_SCAN_COLUMNS)
      .eq("search_filter_id", filterId)
      .order("started_at", { ascending: false })
      .limit(SOURCE_SCAN_READ_LIMIT),
    view === "active"
      ? supabase
        .from("listing_filter_matches")
        .select("listing_id", { count: "exact", head: true })
        .eq("search_filter_id", filterId)
        .eq("is_current_match", false)
        .not("match_reasons", "cs", '["review"]')
      : Promise.resolve(null),
    summaryOnly ? Promise.resolve([] as ResaleCompRecord[]) : readResaleComps(supabase),
  ]);
  if (isFilterMissing(filter)) {
    return null;
  }

  if (membershipResult.error || scansResult.error) {
    console.error("FLIP FINDER RESULTS ERROR:", membershipResult.error ?? scansResult.error);
    throw new Error("Nie udało się pobrać wyników filtra.");
  }
  const membershipRows = asRows(membershipResult.data);
  stats.membershipRowsRead = membershipRows.length;
  stats.sourceScanRowsRead = asRows(scansResult.data).length;

  const allMatches = dedupeByListingId(membershipRows
    .map(toMatchRow)
    .filter((match): match is MatchRow => match !== null && match.searchFilterId === filterId));
  // The OR filter above is the server-side form of visibleMembership(). It is
  // re-applied here so a legacy row (or a client that ignores the filter) can
  // never leak a historical membership into the active sections; the archive
  // view shows only non-visible (historical) rows for the same reason.
  const matches = view === "active" ? allMatches.filter(visibleMembership) : allMatches.filter((match) => !visibleMembership(match));
  const archiveTotal = view === "archive" ? countFromResult(membershipResult, archiveOffset + membershipRows.length) : 0;
  const archivedCount = view === "active" ? countFromResult(archivedCountResult, 0) : archiveTotal;

  // Never keep showing "running" for a scan the platform has already abandoned.
  const scans = asRows(scansResult.data)
    .map((row) => toSearchFilterScan(row, Date.now()))
    .filter((scan): scan is SearchFilterScan => scan !== null);
  const lastScan = scans.reduce<SearchFilterScan | null>((current, scan) => (!current || scan.startedAt > current.startedAt ? scan : current), null);
  const latestCompletedScan = scans.reduce<CompletedScanWindow | null>((current, scan) => {
    if (scan.status !== "completed" || !scan.finishedAt) return current;
    return !current || scan.finishedAt > current.finishedAt ? { startedAt: scan.startedAt, finishedAt: scan.finishedAt } : current;
  }, null);

  const finish = (partial: Omit<FilterResultsPayload, "filter" | "lastScan" | "sourceScans" | "diagnostics" | "counts" | "total" | "newMatches" | "archive">): FilterResultsPayload => ({
    filter,
    ...partial,
    archive: view === "archive" ? { offset: archiveOffset, limit: archiveLimit, total: archiveTotal, hasMore: archiveOffset + membershipRows.length < archiveTotal } : null,
    counts: {
      active: partial.results.length,
      review: partial.reviewResults.length,
      buildingVerification: partial.buildingVerificationResults.length,
      excluded: partial.excludedResults.length,
      archived: archivedCount,
    },
    total: partial.results.length,
    newMatches: partial.results.filter((result) => result.isNew).length,
    lastScan,
    sourceScans: scans,
    diagnostics: { view, ...stats, durationMs: Date.now() - startedAt },
  });

  if (matches.length === 0) {
    return finish({
      results: [],
      reviewResults: [],
      buildingVerificationResults: [],
      excludedResults: [],
      archivedResults: [],
      identityFeatures: { automaticEvidenceAvailable: false, manualReviewAvailable: false, buildingConfirmationAvailable: false },
    });
  }

  const listingIds = matches.map((match) => match.listingId);
  const baseListingColumns = (includeYearBuilt: boolean) =>
    `id,external_listing_id,content_hash,title,price,area,rooms,floor,building_type${includeYearBuilt ? ",year_built" : ""},ownership,description,price_per_sqm,address,city,district,images,original_url,source,status,first_seen_at,last_seen_at,lifecycle_status,review_reason,missing_fields,manual_decision,manual_decision_reason,archived_at,estimated_sale_price,estimated_profit,estimated_roi,flip_score,gallery_status,gallery_job_id,gallery_requested_at,gallery_completed_at,gallery_error,gallery_total,gallery_persisted_count`;
  // No status/lifecycle filter here: only the ~100 current memberships are
  // read, and an archived/removed/rejected listing behind a current
  // membership must be reported with its reason instead of vanishing.
  const buildListingQuery = (idChunk: string[], identityColumns: "both" | "cross" | "none", includeYearBuilt = true) =>
    supabase
      .from("listings")
      .select(`${baseListingColumns(includeYearBuilt)}${identityColumns === "both" ? ",cross_source_identity,identity_evidence" : identityColumns === "cross" ? ",cross_source_identity" : ""}`)
      .in("id", idChunk)
      .order("id", { ascending: true });
  const [initialListingsResult, snapshotsResult, confirmations, manualIdentityScope] = await Promise.all([
    fetchAllRowsForIds(listingIds, (idChunk) => buildListingQuery(idChunk, "both")),
    summaryOnly ? Promise.resolve({ data: [] as Row[], error: null }) : readPublicationSnapshots(supabase, listingIds),
    readBuildingTypeConfirmations(supabase as unknown as Parameters<typeof readBuildingTypeConfirmations>[0], listingIds),
    operatorId
      ? readManualIdentityScope(supabase, operatorId, filterId)
      : Promise.resolve({ available: false, groupByListing: new Map<string, string>(), blockedPairs: new Set<string>() }),
  ]);
  let listingsResult = initialListingsResult;
  let identityEvidenceAvailable = true;
  let identityColumns: "both" | "cross" | "none" = "both";
  let yearBuiltAvailable = true;
  // These columns were introduced by independent, optional migrations. Retry
  // only when PostgREST identifies the specific missing column.
  for (let attempt = 0; listingsResult.error && attempt < 3; attempt += 1) {
    if (identityColumns === "both" && isMissingSelectedColumn(listingsResult.error, "identity_evidence")) {
      identityColumns = "cross";
      identityEvidenceAvailable = false;
    } else if (identityColumns !== "none" && isMissingSelectedColumn(listingsResult.error, "cross_source_identity")) {
      identityColumns = "none";
      identityEvidenceAvailable = false;
    } else if (yearBuiltAvailable && isMissingSelectedColumn(listingsResult.error, "year_built")) {
      yearBuiltAvailable = false;
    } else {
      break;
    }
    listingsResult = await fetchAllRowsForIds(listingIds, (idChunk) => buildListingQuery(idChunk, identityColumns, yearBuiltAvailable));
  }
  if (listingsResult.error?.code === "42703" || listingsResult.error?.code === "PGRST204") {
    // Compatibility for pre-lifecycle schemas remains separate from optional identity columns.
    identityEvidenceAvailable = false;
    listingsResult = await fetchAllRowsForIds(listingIds, (idChunk) =>
      supabase.from("listings").select("id,title,price,area,rooms,floor,building_type,ownership,description,price_per_sqm,address,city,district,images,original_url,source,status,first_seen_at,last_seen_at").in("id", idChunk).order("id", { ascending: true }),
    ) as typeof initialListingsResult;
  }
  if (listingsResult.error || snapshotsResult.error) {
    console.error("FLIP FINDER RESULTS LISTINGS ERROR:", listingsResult.error ?? snapshotsResult.error);
    throw new Error("Nie udało się pobrać ofert dla filtra.");
  }
  stats.listingRowsRead = asRows(listingsResult.data).length;
  stats.snapshotRowsRead = asRows(snapshotsResult.data).length;

  // listing_source_metadata contains private source-post material. Only
  // initialize the service client for this table when Facebook rows exist.
  const facebookListingIds = [...new Set(asRows(listingsResult.data)
    .filter((row) => row.source === "facebook" && typeof row.id === "string")
    .map((row) => String(row.id)))];
  let priceQualityResult: { data: unknown; error: { message?: string; code?: string } | null } = { data: [], error: null };
  if (facebookListingIds.length > 0) {
    try {
      const admin = getAdminClient();
      priceQualityResult = await fetchAllRowsForIds(facebookListingIds, (idChunk) => {
        stats.queryCount += 1;
        return admin.from("listing_source_metadata")
          .select("listing_id,source_post_url,collected_at,published_at,metadata")
          .in("listing_id", idChunk)
          .eq("source", "facebook")
          .order("id", { ascending: true });
      });
    } catch (error) {
      priceQualityResult = { data: [], error: { message: error instanceof Error ? error.message : "service client unavailable" } };
    }
  }
  const priceReliabilityByListingId = new Map<string, FacebookPriceStatus>();
  const sourcePostUrlByListingId = new Map<string, string | null>();
  const sourcePostIdByListingId = new Map<string, string | null>();
  const listingIntentByListingId = new Map<string, string | null>();
  const sourceMetadataCollectedAtByListingId = new Map<string, string>();
  const sourcePublishedAtByListingId = new Map<string, string[]>();
  // "Query failed" must not silently restore trusted-by-default scoring for
  // Facebook (no other source of price truth); OLX/Otodom are unaffected.
  const priceQualityMetadataQueryFailed = Boolean(priceQualityResult.error);
  if (priceQualityMetadataQueryFailed) {
    console.error("FLIP FINDER PRICE RELIABILITY METADATA ERROR:", priceQualityResult.error);
  } else {
    for (const row of asRows(priceQualityResult.data)) {
      const listingId = nullableString(row.listing_id);
      const sourcePostUrl = nullableString(row.source_post_url);
      const collectedAt = nullableString(row.collected_at);
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Row : {};
      const publishedAt = normalizePublicationDate(row.published_at, now);
      if (listingId && publishedAt) sourcePublishedAtByListingId.set(listingId, [...(sourcePublishedAtByListingId.get(listingId) ?? []), publishedAt]);
      const previousCollectedAt = listingId ? sourceMetadataCollectedAtByListingId.get(listingId) : null;
      const isNewer = !previousCollectedAt || !collectedAt || collectedAt > previousCollectedAt;
      if (listingId && isNewer) {
        sourcePostUrlByListingId.set(listingId, sourcePostUrl);
        sourcePostIdByListingId.set(listingId, nullableString(metadata.postId));
        listingIntentByListingId.set(listingId, nullableString(metadata.listingIntent));
        if (collectedAt) sourceMetadataCollectedAtByListingId.set(listingId, collectedAt);
      }
      const status = parseFacebookPriceReliability(row.metadata);
      if (listingId && status) priceReliabilityByListingId.set(listingId, status);
    }
  }

  const listingsById = new Map(
    asRows(listingsResult.data)
      .map(toListingRow)
      .filter((listing): listing is ListingRow => listing !== null)
      .map((listing) => {
        const sourcePostUrl = sourcePostUrlByListingId.get(listing.id) ?? null;
        const location = [listing.address, listing.district, listing.city].filter(Boolean).join(", ");
        const parameterLocation = [listing.address, listing.district].filter(Boolean);
        const parameterFingerprint = listing.source === "facebook" && parameterLocation.length > 0
          ? canonicalFacebookParameterFingerprint({ title: listing.title, description: listing.description, price: listing.price, area: listing.area, rooms: listing.rooms, location: [...parameterLocation, listing.city].filter(Boolean).join(", ") })
          : null;
        const contentFingerprint = listing.source === "facebook" && (Boolean(listing.description) || Boolean(location) || listing.images.length > 0)
          ? canonicalFacebookContentFingerprint({ title: listing.title, description: listing.description, price: listing.price, area: listing.area, rooms: listing.rooms, location, imageUrls: listing.images })
          : listing.contentHash;
        return [listing.id, {
          ...listing,
          sourcePostUrl,
          parameterFingerprint,
          facebookPostId: sourcePostIdByListingId.get(listing.id) ?? null,
          contentFingerprint,
          listingIntent: listingIntentByListingId.get(listing.id) ?? null,
          sourceMetadataCollectedAt: sourceMetadataCollectedAtByListingId.get(listing.id) ?? null,
          originalUrl: resolveListingUrl({ source: listing.source, sourcePostUrl, originalUrl: listing.originalUrl }),
          priceReliability: resolveFacebookPriceReliabilityOnMetadataFailure(listing.source, priceReliabilityByListingId.get(listing.id), priceQualityMetadataQueryFailed),
        } satisfies ListingRow];
      }),
  );
  const snapshotsByListingId = new Map<string, SnapshotRow[]>();
  for (const snapshot of asRows(snapshotsResult.data).map(toSnapshotRow).filter((entry): entry is SnapshotRow => entry !== null)) {
    const snapshots = snapshotsByListingId.get(snapshot.listingId) ?? [];
    snapshots.push(snapshot);
    snapshotsByListingId.set(snapshot.listingId, snapshots);
  }
  for (const snapshots of snapshotsByListingId.values()) snapshots.sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));

  const rows: FinderRow[] = [];
  const missingListingMatches: MatchRow[] = [];
  for (const match of matches) {
    const listing = listingsById.get(match.listingId);
    if (!listing) {
      missingListingMatches.push(match);
      continue;
    }
    rows.push(buildFinderRow({
      listing,
      match,
      filter,
      now,
      latestCompletedScan,
      snapshots: snapshotsByListingId.get(listing.id) ?? [],
      facebookPublishedAt: sourcePublishedAtByListingId.get(listing.id) ?? [],
      operatorBuildingType: confirmations.byListing.get(listing.id) ?? null,
      comps,
      summaryOnly,
    }));
  }
  const missingExcluded = missingListingMatches.map((match) => toExcludedResult(missingListingRow(match), "listing_missing", [], filter));

  if (view === "archive") {
    const archivedResults = sortResults(rows, "newest").map((row) => stripRow(row));
    return finish({
      results: [],
      reviewResults: [],
      buildingVerificationResults: [],
      excludedResults: missingExcluded,
      archivedResults,
      identityFeatures: { automaticEvidenceAvailable: identityEvidenceAvailable, manualReviewAvailable: manualIdentityScope.available, buildingConfirmationAvailable: confirmations.available },
    });
  }

  const partition = partitionFinderRows(rows, {
    filter,
    identityOf: (row) => {
      const listing = listingsById.get(row.id);
      return {
        listingId: row.id,
        source: row.source,
        externalListingId: listing?.externalListingId ?? null,
        sourcePostUrl: row.sourcePostUrl,
        originalUrl: row.originalUrl,
        facebookPostId: listing?.facebookPostId ?? null,
        parameterFingerprint: listing?.parameterFingerprint ?? null,
        contentFingerprint: listing?.contentFingerprint ?? listing?.contentHash ?? null,
      };
    },
    qualityCompare: (left, right) => {
      const leftQuality = ((normalizeListingIdentityUrl(left.source, left.sourcePostUrl) ?? normalizeListingIdentityUrl(left.source, left.originalUrl)) ? 2 : 0) + (left.images.length > 0 ? 1 : 0);
      const rightQuality = ((normalizeListingIdentityUrl(right.source, right.sourcePostUrl) ?? normalizeListingIdentityUrl(right.source, right.originalUrl)) ? 2 : 0) + (right.images.length > 0 ? 1 : 0);
      if (rightQuality !== leftQuality) return rightQuality - leftQuality;
      const leftObserved = sourceMetadataCollectedAtByListingId.get(left.id) ?? left.lastSeenAt ?? left.firstSeenAt;
      const rightObserved = sourceMetadataCollectedAtByListingId.get(right.id) ?? right.lastSeenAt ?? right.firstSeenAt;
      return Date.parse(rightObserved) - Date.parse(leftObserved);
    },
    grouping: { blockedPairs: manualIdentityScope.blockedPairs, manualGroupByListing: manualIdentityScope.groupByListing, ...options.identity },
  });

  return finish({
    results: sortResults(partition.matched, "newest").map(stripRow),
    reviewResults: sortResults(partition.review, "newest").map(stripRow),
    buildingVerificationResults: sortResults(partition.buildingVerification, "newest").map(stripRow),
    excludedResults: [...partition.excluded, ...missingExcluded],
    archivedResults: [],
    identityFeatures: { automaticEvidenceAvailable: identityEvidenceAvailable, manualReviewAvailable: manualIdentityScope.available, buildingConfirmationAvailable: confirmations.available },
  });
}

function buildFinderRow(input: {
  listing: ListingRow;
  match: MatchRow;
  filter: SearchFilter;
  now: number;
  latestCompletedScan: CompletedScanWindow | null;
  snapshots: SnapshotRow[];
  facebookPublishedAt: string[];
  operatorBuildingType: string | null;
  comps: ResaleCompRecord[];
  summaryOnly: boolean;
}): FinderRow {
  const { listing, match, filter, now } = input;
  const previousPrice = previousDifferentPrice(input.snapshots, listing.price);
  const status = resultStatus({ firstMatchedAt: match.firstMatchedAt, previousPrice, currentPrice: listing.price }, input.latestCompletedScan);
  const safeLocation = safeFacebookDisplayLocation(listing);
  const locationText = resultLocation(safeLocation.address, safeLocation.district, safeLocation.city);
  const pricePerSqm = reliablePricePerSqm(listing.pricePerSqm, listing.price, listing.area);
  const filterDecision = evaluateCanonicalListingDecision(
    {
      price: listing.price,
      area: listing.area,
      pricePerSqm,
      rooms: listing.rooms,
      floor: listing.floor,
      city: safeLocation.city,
      district: safeLocation.district,
      title: listing.title,
      description: listing.description,
      locationText,
      // The persisted structured value (not the read-time reconciled one), so
      // the shared qualification sees source data and text separately.
      buildingType: (listing.rawBuildingType ?? listing.buildingType) as string | null,
      yearBuilt: listing.yearBuilt ?? null,
      ownership: listing.ownership,
      listingIntent: listing.listingIntent,
      buildingTypeConfirmedByOperator: input.operatorBuildingType,
    },
    filter,
  );
  // A manual ACCEPT (apply_listing_review_decision: is_current_match=true,
  // reasons "manual_accept") is the operator vouching for the missing data.
  // It used to be re-evaluated as REVIEW on every read, so an accepted offer
  // never showed under Dopasowane. Hard rejections still win, and an unknown
  // building type still needs its own explicit confirmation.
  const manuallyAccepted = listing.manualDecision === "ACCEPTED" && filterDecision.bucket === "REVIEW"
    && !filterDecision.missingFields.includes("buildingType");
  const evaluatedBucket = manuallyAccepted ? "MATCHED" : filterDecision.bucket;
  const sourceConflict = listing.originalUrl ? !sourceDomainMatchesSource(listing.source, listing.originalUrl) : false;
  const finderCleared = match.matchReasons.includes("finder_cleared");
  const exclusion = exclusionFor({ listing, sourceConflict, finderCleared, hardRejectReasons: filterDecision.hardRejectReasons });
  const decisionBucket: FilterResult["decisionBucket"] = exclusion ? "REJECTED" : evaluatedBucket;
  const unknownFields = decisionBucket === "MATCHED" ? [] : filterDecision.missingFields;
  const finderSection = exclusion ? "EXCLUDED" : sectionForDecision(decisionBucket, unknownFields);
  const expectedLifecycle = decisionBucket === "MATCHED" ? "ACTIVE" : decisionBucket === "REVIEW" ? "REVIEW" : "REJECTED";
  const persistedReview = reviewMembership(match);
  const consistencyMismatch = !finderCleared && (listing.lifecycleStatus !== expectedLifecycle
    || match.isCurrentMatch !== (decisionBucket === "MATCHED")
    || (decisionBucket === "REVIEW" && !persistedReview));
  const canonicalDebug = canonicalVisibilityDebug({
    listingId: listing.id,
    canonicalBucket: decisionBucket,
    lifecycleStatus: listing.lifecycleStatus ?? null,
    isCurrentMatch: match.isCurrentMatch,
    matchReasons: [...filterDecision.reasons, ...(decisionBucket === "REVIEW" ? ["review", ...filterDecision.missingFields.map((field) => `unknown_${field}`)] : [])],
    visibilityInFinder: finderSection !== "EXCLUDED",
    visibilityInWatcher: listing.source === "facebook",
    reason: finderCleared ? "cleared_by_operator" : exclusion ? `${exclusion.code}${exclusion.reasons.length ? `:${exclusion.reasons.join(",")}` : ""}` : decisionBucket === "REVIEW" ? "review_uncertainty" : manuallyAccepted ? "manual_accept" : "current_filter_match",
    consistencyMismatch,
  });
  const publicationValues = listing.source === "facebook" && input.facebookPublishedAt.length
    ? input.facebookPublishedAt
    : input.snapshots.flatMap((snapshot) => snapshot.publishedCandidates);
  const publishedAt = earliestPublicationDate(publicationValues, now);
  const latestPublishedAt = latestPublicationDate(publicationValues, now);
  const freshness = listingFreshness(publishedAt, listing.lastSeenAt, now);
  const effectiveGalleryDisplay = effectiveGalleryDisplayState(listing.galleryStatus ?? null, listing.galleryRequestedAt ?? null, listing.galleryError ?? null);

  return {
    id: listing.id,
    title: listing.title,
    price: listing.price,
    area: listing.area,
    rooms: listing.rooms,
    floor: listing.floor,
    totalFloors: null,
    buildingType: filterDecision.buildingQualification?.type ?? listing.buildingType,
    yearBuilt: listing.yearBuilt ?? null,
    ownership: listing.ownership,
    description: listing.description,
    images: listing.images,
    pricePerSqm,
    locationText,
    address: safeLocation.address,
    city: safeLocation.city,
    district: safeLocation.district,
    thumbnailUrl: listing.images[0] ?? null,
    originalUrl: listing.originalUrl,
    sourcePostUrl: listing.sourcePostUrl ?? null,
    source: listing.source,
    crossSourceIdentity: listing.crossSourceIdentity ?? null,
    identityEvidence: listing.identityEvidence,
    sourceConflict,
    listingStatus: listing.status,
    isActive: listing.status === "active",
    publishedAt,
    latestPublishedAt: latestPublishedAt !== publishedAt ? latestPublishedAt : null,
    publicationAgeDays: freshness.ageDays,
    isOlderListing: freshness.isOlderListing,
    lastVerifiedDaysAgo: freshness.lastVerifiedDaysAgo,
    verificationStale: freshness.verificationStale,
    firstSeenAt: listing.firstSeenAt,
    lastSeenAt: listing.lastSeenAt,
    firstMatchedAt: match.firstMatchedAt,
    lastMatchedAt: match.lastMatchedAt,
    previousPrice: status.hasPriceDrop ? previousPrice : null,
    currentPrice: listing.price,
    ...status,
    isNew: match.matchOrigin === "scan" && status.isNew,
    matchReasons: [...filterDecision.reasons, ...(evaluatedBucket === "REVIEW" ? ["review"] : []), ...(manuallyAccepted ? ["manual_accept"] : [])],
    unknownFields,
    decisionBucket,
    finderStatus: canonicalDebug.finderStatus,
    canonicalDecisionDebug: canonicalDebug,
    canonicalConsistencyMismatch: consistencyMismatch,
    // A Finder clear is scoped to this filter's membership: project it as archived here only.
    lifecycleStatus: finderCleared ? "ARCHIVED" : listing.lifecycleStatus,
    reviewReason: listing.reviewReason,
    missingFields: listing.missingFields,
    manualDecision: listing.manualDecision,
    manualDecisionReason: listing.manualDecisionReason,
    archivedAt: listing.archivedAt,
    // A PENDING/RUNNING gallery no extension ever claimed has no proactive
    // reaper; this display-time check stops "Oczekuje na pobranie galerii" forever.
    galleryStatus: effectiveGalleryDisplay.status ?? undefined,
    galleryJobId: listing.galleryJobId,
    galleryTotal: listing.galleryTotal,
    galleryPersistedCount: listing.galleryPersistedCount,
    galleryError: effectiveGalleryDisplay.error ?? undefined,
    buildingQualification: filterDecision.buildingQualification ?? undefined,
    buildingTypeConfirmedByOperator: input.operatorBuildingType,
    finderSection,
    exclusion,
    isCurrentMatch: match.isCurrentMatch,
    ...(input.summaryOnly ? emptyOpportunityFields() : opportunityFields(listing, filter, decisionBucket, input.comps)),
  };
}

/**
 * Why a current membership is not shown in an active section. Order matters:
 * the most fundamental reason wins so the operator sees one clear cause.
 */
function exclusionFor(input: { listing: ListingRow; sourceConflict: boolean; finderCleared: boolean; hardRejectReasons: string[] }): FinderRow["exclusion"] {
  const { listing } = input;
  const make = (code: FinderExclusionCode, reasons: string[] = []) => ({ code, reasons });
  if (listing.status !== "active") return make("listing_inactive", [listing.status]);
  if (listing.manualDecision === "REJECTED") return make("manual_rejected");
  if (input.finderCleared || listing.lifecycleStatus === "ARCHIVED") return make("lifecycle_archived");
  if (listing.lifecycleStatus === "STALE") return make("lifecycle_stale");
  if (input.hardRejectReasons.length > 0) return make("filter_rejected", input.hardRejectReasons);
  if (listing.lifecycleStatus === "REJECTED") return make("lifecycle_rejected");
  if (input.sourceConflict) return make("source_conflict");
  if (listing.source !== "facebook" && !isValidSalePrice(listing.price)) return make("invalid_price");
  return null;
}

/** Removes internal partition bookkeeping before the payload leaves the server. */
function stripRow(row: FilterResult): FilterResult {
  const { exclusion: _exclusion, isCurrentMatch: _isCurrentMatch, ...result } = row as FinderRow;
  void _exclusion;
  void _isCurrentMatch;
  return result;
}

function missingListingRow(match: MatchRow): FinderRow {
  return {
    id: match.listingId, title: null, price: null, area: null, rooms: null, floor: null, totalFloors: null, buildingType: null,
    ownership: null, description: null, images: [], pricePerSqm: null, locationText: null, address: null, city: null, district: null,
    thumbnailUrl: null, originalUrl: null, source: "otodom", listingStatus: "removed", isActive: false, firstSeenAt: match.firstMatchedAt,
    lastSeenAt: match.lastMatchedAt, firstMatchedAt: match.firstMatchedAt, lastMatchedAt: match.lastMatchedAt, previousPrice: null,
    currentPrice: null, isNew: false, hasPriceDrop: false, priceDropAmount: null, matchReasons: match.matchReasons, unknownFields: [],
    finderSection: "EXCLUDED", isCurrentMatch: match.isCurrentMatch,
  };
}

const PUBLICATION_KEYS = ["sourcePublishedAt", "publishedAt", "published_at", "datePosted", "datePostedAt", "datePublished", "date_published", "postedAt", "posted_at"] as const;
/**
 * Only the publication fields are projected out of raw_data (PostgREST JSON
 * path selects) instead of shipping every snapshot's full source payload to
 * the server on each Finder open.
 */
const SNAPSHOT_PUBLICATION_SELECT = [
  "listing_id",
  "price",
  "captured_at",
  ...PUBLICATION_KEYS.map((key) => `pub_${key}:raw_data->>${key}`),
  ...PUBLICATION_KEYS.map((key) => `cand_${key}:raw_data->candidate->>${key}`),
].join(",");

async function readPublicationSnapshots(supabase: SupabaseSession, listingIds: string[]): Promise<{ data: Row[]; error: { message?: string; code?: string } | null }> {
  const slim = await fetchAllRowsForIds(listingIds, (idChunk) =>
    supabase
      .from("listing_snapshots")
      .select(SNAPSHOT_PUBLICATION_SELECT)
      .in("listing_id", idChunk)
      // captured_at alone is not unique across listings; listing_id makes the page order total.
      .order("captured_at", { ascending: false })
      .order("listing_id", { ascending: true }),
  );
  if (!slim.error) return slim;
  // A PostgREST that rejects JSON-path selects falls back to the full payload.
  console.error("FLIP FINDER SNAPSHOT SLIM SELECT ERROR:", slim.error);
  return fetchAllRowsForIds(listingIds, (idChunk) =>
    supabase
      .from("listing_snapshots")
      .select("listing_id,price,captured_at,raw_data")
      .in("listing_id", idChunk)
      .order("captured_at", { ascending: false })
      .order("listing_id", { ascending: true }),
  );
}

async function readVisibleMemberships(supabase: SupabaseSession, filterId: string): Promise<{ data: Row[]; error: { message?: string; code?: string } | null }> {
  const membershipColumns = "listing_id,search_filter_id,first_matched_at,last_matched_at,is_current_match,match_origin,match_reasons";
  const visible = await fetchAllRows(() => supabase
    .from("listing_filter_matches")
    .select(membershipColumns)
    .eq("search_filter_id", filterId)
    .or(FINDER_REVIEW_MEMBERSHIP_OR_FILTER)
    // listing_id is unique within one filter: a deterministic total order for paging.
    .order("listing_id", { ascending: true }));
  if (!visible.error) return visible;
  // Correctness first: if PostgREST ever rejects the JSON containment filter,
  // fall back to the complete (heavier) membership read and filter in memory.
  console.error("FLIP FINDER VISIBLE MEMBERSHIP FILTER ERROR, falling back to full read:", visible.error);
  return fetchAllRows(() => supabase
    .from("listing_filter_matches")
    .select(membershipColumns)
    .eq("search_filter_id", filterId)
    .order("listing_id", { ascending: true }));
}

let resaleCompsCache: { loadedAt: number; comps: ResaleCompRecord[] } | null = null;

/**
 * Market comparables change at scan cadence, not per Finder open. A short
 * in-instance cache removes the 500-row comps read from repeated opens
 * without changing scoring inputs. The comp description is never used by
 * the ARV model, so it is not read.
 */
async function readResaleComps(supabase: SupabaseSession): Promise<ResaleCompRecord[]> {
  if (resaleCompsCache && Date.now() - resaleCompsCache.loadedAt < RESALE_COMPS_CACHE_TTL_MS) return resaleCompsCache.comps;
  const result = await supabase
    .from("resale_comps")
    .select("id,source,external_listing_id,canonical_url,title,city,district,street,address,latitude,longitude,price,area_m2,price_per_m2,rooms,floor,floors,building_type,construction_year,ownership,balcony,elevator,parking,renovation_status,renovation_confidence,finish_level,listing_created_at,first_seen_at,last_seen_at,active,seller_type,fingerprint,outlier_reason,evidence")
    .eq("active", true)
    .limit(500);
  if (result.error) return [];
  const comps = asRows(result.data).map(toResaleCompRecord).filter((comp): comp is ResaleCompRecord => comp !== null);
  resaleCompsCache = { loadedAt: Date.now(), comps };
  return comps;
}

/** TEST-ONLY: resets in-instance read caches between isolated fake databases. */
export function resetFinderReadCachesForTests(): void {
  resaleCompsCache = null;
}

function countFromResult(result: unknown, fallback: number): number {
  const count = result && typeof result === "object" ? (result as { count?: unknown }).count : undefined;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
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

async function readManualIdentityScope(supabase: Awaited<ReturnType<typeof createClient>>, ownerId: string, filterId: string): Promise<{ available: boolean; groupByListing: Map<string, string>; blockedPairs: Set<string> }> {
  const [groups, decisions] = await Promise.all([
    supabase.from("finder_listing_identity_groups").select("listing_id,group_id").eq("owner_id", ownerId).eq("search_filter_id", filterId),
    supabase.from("finder_listing_identity_decisions").select("listing_a,listing_b,decision").eq("owner_id", ownerId).eq("search_filter_id", filterId).eq("decision", "not_link"),
  ]);
  const missingTable = isMissingIdentityTable(groups.error) || isMissingIdentityTable(decisions.error);
  if (missingTable) return { available: false, groupByListing: new Map(), blockedPairs: new Set() };
  if (groups.error || decisions.error) {
    console.error("FLIP FINDER IDENTITY DECISIONS ERROR:", groups.error ?? decisions.error);
    throw new Error("Nie udało się pobrać ręcznych decyzji łączenia ofert.");
  }
  const groupByListing = new Map<string, string>();
  for (const row of asRows(groups.data)) {
    const listingId = nullableString(row.listing_id);
    const groupId = nullableString(row.group_id);
    if (listingId && groupId) groupByListing.set(listingId, groupId);
  }
  const blockedPairs = new Set<string>();
  for (const row of asRows(decisions.data)) {
    const left = nullableString(row.listing_a);
    const right = nullableString(row.listing_b);
    if (left && right) blockedPairs.add(identityPairKey(left, right));
  }
  return { available: true, groupByListing, blockedPairs };
}

function isMissingIdentityTable(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42P01" || code === "PGRST205") && /finder_listing_identity_(?:groups|decisions)/u.test(message);
}

function isMissingSelectedColumn(error: { code?: unknown; message?: unknown } | null, column: string): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42703" || code === "PGRST204") && new RegExp(`\\b${column}\\b`, "u").test(message);
}

export function toListingRow(row: Row): ListingRow | null {
  const id = nullableString(row.id);
  const originalUrl = nullableString(row.original_url);
  const source = nullableString(row.source);
  const status = nullableString(row.status);
  const firstSeenAt = nullableString(row.first_seen_at);
  const lastSeenAt = nullableString(row.last_seen_at);

  if (
    !id ||
    !isListingSource(source) ||
    !isListingStatus(status) ||
    !firstSeenAt ||
    !lastSeenAt
  ) {
    return null;
  }

  return {
    id,
    crossSourceIdentity: nullableString(row.cross_source_identity),
    identityEvidence: normalizeListingIdentityEvidence(row.identity_evidence),
    externalListingId: nullableString(row.external_listing_id),
    contentHash: nullableString(row.content_hash),
    title: nullableString(row.title),
    price: nullableNumber(row.price),
    area: nullableNumber(row.area),
    rooms: nullableNumber(row.rooms),
    floor: nullableString(row.floor),
    // Reconcile the stored structure with the current listing's own text on
    // every read. This prevents legacy `building_type=blok` rows whose
    // description explicitly identifies a tenement from resurfacing as a
    // confirmed match after an older import/recalculation.
    buildingType: resolveBuildingType(row.building_type, nullableString(row.title), nullableString(row.description)),
    rawBuildingType: row.building_type ?? null,
    yearBuilt: nullableNumber(row.year_built),
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
    sourceUrl: listing.originalUrl ?? undefined,
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
  } : emptyOpportunityFields();
}

function emptyOpportunityFields(): ReturnType<typeof opportunityFields> {
  return {
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
  if (!listingId || !capturedAt) return null;
  const raw = isRow(row.raw_data) ? row.raw_data : null;
  const candidate = raw && isRow(raw.candidate) ? raw.candidate : null;
  // Either the slim JSON-path projection (pub_*/cand_*) or, on fallback, the full raw_data.
  const publishedCandidates = raw
    ? [...PUBLICATION_KEYS.map((key) => raw[key]), ...(candidate ? PUBLICATION_KEYS.map((key) => candidate[key]) : [])]
    : [...PUBLICATION_KEYS.map((key) => row[`pub_${key}`]), ...PUBLICATION_KEYS.map((key) => row[`cand_${key}`])];
  return {
    listingId,
    price: nullableNumber(row.price),
    capturedAt,
    // The first source-provided key wins per snapshot, exactly as before.
    publishedCandidates: [firstPublicationValue(publishedCandidates.slice(0, PUBLICATION_KEYS.length)), firstPublicationValue(publishedCandidates.slice(PUBLICATION_KEYS.length))].filter((value) => value !== null),
  };
}

function firstPublicationValue(values: unknown[]): string | null {
  for (const value of values) {
    // ->> renders a numeric JSON value as text; only real date strings are publication dates.
    if (typeof value === "string" && !/^\d+$/u.test(value.trim()) && normalizePublicationDate(value) !== null) return value;
  }
  return null;
}

export function toSearchFilterScan(row: Row, now: number): SearchFilterScan | null {
  const id = nullableString(row.id);
  const searchFilterId = nullableString(row.search_filter_id);
  const source = nullableString(row.source);
  const rawStatus = nullableString(row.status);
  const startedAt = nullableString(row.started_at);

  if (
    !id ||
    !searchFilterId ||
    !isListingSource(source) ||
    !isSearchFilterScanStatus(rawStatus) ||
    !startedAt
  ) {
    return null;
  }

  // Facebook/OLX rows have their own dedicated watchdogs (the Watcher
  // scheduler and the OLX lease recovery) that already run independently of
  // this read -- reclassifying them here too would risk disagreeing with
  // whichever one of those is currently mid-recovery for the same row.
  // The Finder results read projects only filter_snapshot->_scanProgress (scan_progress).
  const snapshot = row.filter_snapshot ?? (row.scan_progress === undefined ? null : { _scanProgress: row.scan_progress });
  const stale = source !== "facebook" && source !== "olx" && isStaleScan({ status: rawStatus, startedAt, heartbeatAt: scanHeartbeatAt(snapshot) }, now);
  const status = stale ? "failed" : rawStatus;
  const errorMessage = stale ? STALE_SCAN_MESSAGE : nullableString(row.error_message);

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

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

/**
 * Supabase/PostgREST caps a response to its configured default row limit
 * (confirmed empirically against this project's own instance: exactly 1000)
 * whenever a query issues neither .range() nor .limit() -- silently, with no
 * error. A filter the size of "Flip" has 2000+ listing_filter_matches rows;
 * reading it with a bare .select().eq() truncated to the first 1000 by
 * whatever order Postgres happened to return them in, permanently hiding
 * every source whose rows landed past that cut (OLX and the official UMŁ
 * catalog among them, confirmed live in Production). Pages through the full
 * result instead of trusting a single unranged response to be complete.
 */
const SUPABASE_SELECT_PAGE_SIZE = 1000;
async function fetchAllRows<E>(
  buildQuery: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: E | null }> },
): Promise<{ data: Row[]; error: E | null }> {
  const rows: Row[] = [];
  for (let start = 0; ; start += SUPABASE_SELECT_PAGE_SIZE) {
    const page = await buildQuery().range(start, start + SUPABASE_SELECT_PAGE_SIZE - 1);
    if (page.error) {
      return { data: rows, error: page.error };
    }
    const pageRows = asRows(page.data);
    rows.push(...pageRows);
    if (pageRows.length < SUPABASE_SELECT_PAGE_SIZE) {
      break;
    }
  }
  return { data: rows, error: null };
}

/**
 * Confirmed empirically against this project's own Supabase instance: an
 * .in("id", [...]) filter with ~400+ UUIDs produces a GET request whose
 * query string exceeds the ~16KB HTTP header limit, failing outright with
 * HeadersOverflowError (undici) for both the anon and the service-role key
 * -- not a truncation, a hard failure. Filter "Flip" has 2158
 * listing_filter_matches rows once fetchAllRows (above) correctly reads all
 * of them, so every .in("id"/"listing_id", listingIds) lookup below needs
 * this just as much as the match query itself needed pagination. Batches
 * the id list into requests small enough to stay well under that limit
 * (Supabase's own error hint recommends under 200) and merges the results;
 * each batch is itself paged via fetchAllRows in case one id chunk's own
 * response is large (e.g. many snapshots per listing).
 */
const ID_FILTER_CHUNK_SIZE = 200;
async function fetchAllRowsForIds<E>(
  ids: string[],
  buildQuery: (idChunk: string[]) => { range(from: number, to: number): PromiseLike<{ data: unknown; error: E | null }> },
): Promise<{ data: Row[]; error: E | null }> {
  const rows: Row[] = [];
  for (let start = 0; start < ids.length; start += ID_FILTER_CHUNK_SIZE) {
    const idChunk = ids.slice(start, start + ID_FILTER_CHUNK_SIZE);
    const page = await fetchAllRows(() => buildQuery(idChunk));
    if (page.error) {
      return { data: rows, error: page.error };
    }
    rows.push(...page.data);
  }
  return { data: rows, error: null };
}

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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

// A bare re-export of the shared, exhaustively-checked LISTING_SOURCES list
// (search-filter-contract.ts) adapted for this file's `string | null` call
// sites. A hand-maintained local copy of this allowlist previously drifted
// out of date and silently excluded every newer registered source (gratka,
// nieruchomosci_online, domiporta, sprzedajemy, adresowo, oferty_net,
// szybko, bezposrednio, domy, allegro_lokalnie) -- toListingRow() returning
// null for any of those sources meant their active listings were silently
// dropped from Finder's results for every filter, and toSearchFilterScan()
// returning null meant their scan rows never appeared as a filter's last
// scan either, regardless of how many real matches or scans existed.
function isListingSource(value: string | null): value is FilterResult["source"] {
  return value !== null && isKnownListingSource(value);
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
