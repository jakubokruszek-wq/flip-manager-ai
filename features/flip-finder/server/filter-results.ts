import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  filterMatchesForFilter,
  isFilterMissing,
  resultLocation,
  resultStatus,
  sortResults,
  type CompletedScanWindow,
  type FilterResult,
} from "@/features/flip-finder/results";
import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import type { PropertyListing } from "@/features/properties/types/property";
import { safeFacebookDisplayLocation } from "@/features/facebook-watcher/facebook-location-quality";
import { createClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

type FilterResultsPayload = {
  filter: SearchFilter;
  results: FilterResult[];
  reviewResults: FilterResult[];
  archivedResults: FilterResult[];
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
>;

type SnapshotRow = {
  listingId: string;
  price: number | null;
  capturedAt: string;
  rawData: Row;
};

export async function getFilterResults(filterId: string): Promise<FilterResultsPayload | null> {
  const filter = await getSearchFilter(filterId);
  if (isFilterMissing(filter)) {
    return null;
  }

  const supabase = await createClient();
  const [matchesResult, scansResult] = await Promise.all([
    supabase
      .from("listing_filter_matches")
      .select("listing_id,search_filter_id,first_matched_at,last_matched_at,match_origin,match_reasons")
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

  const matches = filterMatchesForFilter(
    asRows(matchesResult.data)
      .map(toMatchRow)
      .filter((match): match is MatchRow => match !== null),
    filterId,
  );
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
      total: 0,
      newMatches: 0,
      lastScan,
      sourceScans: scans,
    };
  }

  const listingIds = matches.map((match) => match.listingId);
  const [listingsResultRaw, snapshotsResult] = await Promise.all([
    supabase
      .from("listings")
      .select(
        "id,title,price,area,rooms,floor,building_type,ownership,description,price_per_sqm,address,city,district,images,original_url,source,status,first_seen_at,last_seen_at,lifecycle_status,review_reason,missing_fields,manual_decision,manual_decision_reason,archived_at",
      )
      .in("id", listingIds)
      .eq("status", "active")
        .in("lifecycle_status", ["ACTIVE", "REVIEW", "STALE", "ARCHIVED", "REJECTED"]),
    supabase
      .from("listing_snapshots")
      .select("listing_id,price,captured_at,raw_data")
      .in("listing_id", listingIds)
      .order("captured_at", { ascending: false }),
  ]);

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

  const listingsById = new Map(
    asRows(listingsResult.data)
      .map(toListingRow)
      .filter((listing): listing is ListingRow => listing !== null)
      .map((listing) => [listing.id, listing]),
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
        locationText: resultLocation(safeLocation.address, safeLocation.district, safeLocation.city),
        address: safeLocation.address,
        city: safeLocation.city,
        district: safeLocation.district,
        thumbnailUrl: listing.images[0] ?? null,
        originalUrl: listing.originalUrl,
        source: listing.source,
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
        matchReasons: match.matchReasons.filter((reason) => !reason.startsWith("unknown_")),
        unknownFields: match.matchReasons
          .filter((reason) => reason.startsWith("unknown_"))
          .map((reason) => reason.slice("unknown_".length)),
        decisionBucket: listing.lifecycleStatus === "REJECTED" ? "REJECTED" : listing.lifecycleStatus === "REVIEW" || match.matchReasons.includes("review") ? "REVIEW" : "MATCHED",
        lifecycleStatus: listing.lifecycleStatus,
        reviewReason: listing.reviewReason,
        missingFields: listing.missingFields,
        manualDecision: listing.manualDecision,
        manualDecisionReason: listing.manualDecisionReason,
        archivedAt: listing.archivedAt,
      },
    ];
  });
  const archivedLifecycle = new Set(["STALE", "ARCHIVED", "REJECTED"]);
  const sortedResults = sortResults(allResults.filter((result) => result.decisionBucket === "MATCHED" && !archivedLifecycle.has(result.lifecycleStatus ?? "")), "newest");
  const reviewResults = sortResults(allResults.filter((result) => result.decisionBucket === "REVIEW" && !archivedLifecycle.has(result.lifecycleStatus ?? "")), "newest");
  const archivedResults = sortResults(allResults.filter((result) => archivedLifecycle.has(result.lifecycleStatus ?? "")), "newest");

  return {
    filter,
    results: sortedResults,
    reviewResults,
    archivedResults,
    total: sortedResults.length,
    newMatches: sortedResults.filter((result) => result.isNew).length,
    lastScan,
    sourceScans: scans,
  };
}

function toMatchRow(row: Row): MatchRow | null {
  const listingId = nullableString(row.listing_id);
  const searchFilterId = nullableString(row.search_filter_id);
  const firstMatchedAt = nullableString(row.first_matched_at);
  const lastMatchedAt = nullableString(row.last_matched_at);
  const matchOrigin = nullableString(row.match_origin) ?? "scan";
  const matchReasons = stringArray(row.match_reasons);

  return listingId && searchFilterId && firstMatchedAt && lastMatchedAt && isMatchOrigin(matchOrigin)
    ? { listingId, searchFilterId, firstMatchedAt, lastMatchedAt, matchOrigin, matchReasons }
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
  };
}

function nullableLifecycle(value: unknown): PropertyListing["lifecycleStatus"] {
  return value === "ACTIVE" || value === "REVIEW" || value === "STALE" || value === "ARCHIVED" || value === "REJECTED" ? value : "ACTIVE";
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

function reliablePricePerSqm(
  storedValue: number | null,
  price: number | null,
  area: number | null,
): number | null {
  if (price !== null && (!Number.isFinite(price) || price < 20_000 || price > 100_000_000)) return null;
  if (storedValue !== null && Number.isFinite(storedValue) && storedValue > 0) {
    return storedValue;
  }

  return price !== null && area !== null && price > 0 && area > 0 ? price / area : null;
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
