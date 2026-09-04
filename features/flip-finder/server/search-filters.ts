import "server-only";

import type { ListingSource, SearchFilter } from "@/features/flip-finder";
import {
  isListingSource,
  isMarketType,
  type SearchFilterInput,
  type SearchFilterListResponse,
  type SearchFilterScan,
} from "@/features/flip-finder/search-filter-contract";
import { createClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export async function listSearchFilters(): Promise<SearchFilterListResponse> {
  const supabase = await createClient();
  const [filtersResult, matchesResult, listingsResult, scansResult] = await Promise.all([
    supabase.from("search_filters").select("*").order("updated_at", { ascending: false }),
    supabase.from("listing_filter_matches").select("search_filter_id").eq("is_current_match", true),
    supabase.from("listings").select("id,status,lifecycle_status"),
    supabase.from("source_scans").select(
      "id,scan_run_id,search_filter_id,source,status,started_at,finished_at,scanned_count,matched_count,listings_created,new_count,listings_updated,price_drop_count,warnings,error_message",
    ),
  ]);

  if (filtersResult.error || matchesResult.error || listingsResult.error || scansResult.error) {
    console.error(
      "FLIP FINDER LIST ERROR:",
      filtersResult.error ?? matchesResult.error ?? listingsResult.error ?? scansResult.error,
    );
    throw new Error("Nie udało się pobrać filtrów.");
  }

  const matchCounts = new Map<string, number>();
  for (const match of asRows(matchesResult.data)) {
    const filterId = asString(match.search_filter_id);

    if (filterId) {
      matchCounts.set(filterId, (matchCounts.get(filterId) ?? 0) + 1);
    }
  }

  const scans = asRows(scansResult.data)
    .map(toSearchFilterScan)
    .filter((scan): scan is SearchFilterScan => scan !== null);
  const latestScans = new Map<string, SearchFilterScan>();
  const latestCompletedScans = new Map<string, SearchFilterScan>();

  for (const scan of scans) {
    const latestScan = latestScans.get(scan.searchFilterId);
    const scanIsActive = scan.status === "pending" || scan.status === "running";
    const latestIsActive = latestScan?.status === "pending" || latestScan?.status === "running";
    if (!latestScan || (scanIsActive && !latestIsActive) || (scanIsActive === latestIsActive && scan.startedAt > latestScan.startedAt)) {
      latestScans.set(scan.searchFilterId, scan);
    }

    if (scan.status !== "completed" || !scan.finishedAt) {
      continue;
    }

    const latestCompletedScan = latestCompletedScans.get(scan.searchFilterId);
    if (!latestCompletedScan || scan.finishedAt > (latestCompletedScan.finishedAt ?? "")) {
      latestCompletedScans.set(scan.searchFilterId, scan);
    }
  }

  const filters = asRows(filtersResult.data)
    .map(toSearchFilter)
    .map((filter) => ({
      ...filter,
      totalMatches: matchCounts.get(filter.id) ?? 0,
      newMatches: latestCompletedScans.get(filter.id)?.newCount ?? 0,
      lastScan: latestScans.get(filter.id) ?? null,
    }));
  const activeFilters = filters.filter((filter) => filter.isActive).length;
  const latestScan = scans.reduce<SearchFilterScan | null>((current, scan) => {
    return !current || scan.startedAt > current.startedAt ? scan : current;
  }, null);

  return {
    filters,
    latestScan,
    summary: {
      activeFilters,
      pausedFilters: filters.length - activeFilters,
      listingsCount: asRows(listingsResult.data).length,
      activeListings: asRows(listingsResult.data).filter((listing) => listing.status === "active" && (!listing.lifecycle_status || listing.lifecycle_status === "ACTIVE")).length,
      removedListings: asRows(listingsResult.data).filter((listing) => listing.status === "removed").length,
      newMatches: filters.reduce((total, filter) => total + filter.newMatches, 0),
    },
  };
}

export async function getSearchFilter(id: string): Promise<SearchFilter | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("search_filters")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("FLIP FINDER GET ERROR:", error);
    throw new Error("Nie udało się pobrać filtra.");
  }

  return data ? toSearchFilter(asRow(data)) : null;
}

export async function getActiveSearchFiltersForSource(
  source: ListingSource,
): Promise<SearchFilter[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("search_filters")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("FLIP FINDER FILTER SOURCE LIST ERROR:", error);
    throw new Error("Nie udało się pobrać filtrów dla importu.");
  }

  return asRows(data)
    .map(toSearchFilter)
    .filter((filter) => filter.sources.includes(source));
}

export async function createSearchFilter(input: SearchFilterInput): Promise<SearchFilter> {
  const filter = await writeSearchFilter(input, null);

  if (!filter) {
    throw new Error("Nie udało się utworzyć filtra.");
  }

  return filter;
}

export async function updateSearchFilter(
  id: string,
  input: SearchFilterInput,
): Promise<SearchFilter | null> {
  return writeSearchFilter(input, id);
}

export async function deleteSearchFilter(id: string): Promise<boolean> {
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("search_filters")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("FLIP FINDER DELETE ERROR:", error);
    throw new Error("Nie udało się usunąć filtra.");
  }

  return (count ?? 0) > 0;
}

export async function duplicateSearchFilter(id: string): Promise<SearchFilter | null> {
  const filter = await getSearchFilter(id);
  if (!filter) {
    return null;
  }

  return createSearchFilter({
    ...filter,
    name: `${filter.name} (kopia)`,
  });
}

export async function toggleSearchFilter(id: string): Promise<SearchFilter | null> {
  const filter = await getSearchFilter(id);
  if (!filter) {
    return null;
  }

  return updateSearchFilter(id, {
    ...filter,
    isActive: !filter.isActive,
  });
}

export function parseSearchFilterInput(value: unknown): SearchFilterInput {
  if (!isRow(value)) {
    throw new Error("Nieprawidłowe dane filtra.");
  }

  const input: SearchFilterInput = {
    name: requiredString(value.name, "Nazwa"),
    sources: stringArray(value.sources, "Źródła").filter(isListingSource),
    city: requiredString(value.city, "Miasto"),
    districts: stringArray(value.districts, "Dzielnice"),
    priceMin: nullableNumber(value.priceMin, "Cena minimalna"),
    priceMax: nullableNumber(value.priceMax, "Cena maksymalna"),
    areaMin: nullableNumber(value.areaMin, "Powierzchnia minimalna"),
    areaMax: nullableNumber(value.areaMax, "Powierzchnia maksymalna"),
    rooms: numberArray(value.rooms, "Pokoje"),
    floorMin: nullableNumber(value.floorMin, "Piętro minimalne"),
    floorMax: nullableNumber(value.floorMax, "Piętro maksymalne"),
    excludeGroundFloor: booleanValue(value.excludeGroundFloor, "Wykluczenie parteru"),
    excludeTopFloor: booleanValue(value.excludeTopFloor, "Wykluczenie ostatniego piętra"),
    buildingTypes: stringArray(value.buildingTypes, "Typy budynków"),
    ownershipTypes: stringArray(value.ownershipTypes, "Formy własności"),
    marketType: nullableMarketType(value.marketType),
    privateOnly: booleanValue(value.privateOnly, "Oferty prywatne"),
    maxPricePerSqm: nullableNumber(value.maxPricePerSqm, "Maksymalna cena za m²"),
    requiredKeywords: stringArray(value.requiredKeywords, "Wymagane słowa"),
    excludedKeywords: stringArray(value.excludedKeywords, "Wykluczone słowa"),
    minFlipScore: nullableNumber(value.minFlipScore, "Minimalny Flip Score"),
    minEstimatedProfit: nullableNumber(value.minEstimatedProfit, "Minimalny zysk"),
    maxEstimatedRenovationCost: nullableNumber(
      value.maxEstimatedRenovationCost,
      "Maksymalny koszt remontu",
    ),
    scanIntervalMinutes: positiveInteger(value.scanIntervalMinutes, "Częstotliwość skanowania"),
    isActive: booleanValue(value.isActive, "Status"),
  };

  if (
    input.sources.length !== stringArray(value.sources, "Źródła").length ||
    input.sources.length === 0
  ) {
    throw new Error("Wybierz co najmniej jedno obsługiwane źródło.");
  }

  if (
    (input.priceMin !== null && input.priceMin < 0) ||
    (input.priceMax !== null && input.priceMax < 0) ||
    (input.maxPricePerSqm !== null && input.maxPricePerSqm < 0) ||
    (input.minEstimatedProfit !== null && input.minEstimatedProfit < 0) ||
    (input.maxEstimatedRenovationCost !== null && input.maxEstimatedRenovationCost < 0)
  ) {
    throw new Error("Wartości finansowe nie mogą być ujemne.");
  }

  if (input.priceMin !== null && input.priceMax !== null && input.priceMin > input.priceMax) {
    throw new Error("Cena minimalna nie może być większa od maksymalnej.");
  }

  if (input.areaMin !== null && input.areaMax !== null && input.areaMin > input.areaMax) {
    throw new Error("Powierzchnia minimalna nie może być większa od maksymalnej.");
  }

  if (input.floorMin !== null && input.floorMax !== null && input.floorMin > input.floorMax) {
    throw new Error("Piętro minimalne nie może być większe od maksymalnego.");
  }

  if (input.minFlipScore !== null && (input.minFlipScore < 0 || input.minFlipScore > 100)) {
    throw new Error("Minimalny Flip Score musi być w zakresie 0–100.");
  }

  return input;
}

async function writeSearchFilter(
  input: SearchFilterInput,
  id: string | null,
): Promise<SearchFilter | null> {
  const payload = toDatabasePayload(input);
  const supabase = await createClient();
  const query = id
    ? supabase.from("search_filters").update(payload).eq("id", id).select("*").maybeSingle()
    : supabase.from("search_filters").insert(payload).select("*").single();
  const { data, error } = await query;

  if (error) {
    console.error("FLIP FINDER WRITE ERROR:", error);
    throw new Error("Nie udało się zapisać filtra.");
  }

  return data ? toSearchFilter(asRow(data)) : null;
}

function toDatabasePayload(input: SearchFilterInput) {
  return {
    name: input.name,
    sources: input.sources,
    city: input.city,
    districts: input.districts,
    price_min: input.priceMin,
    price_max: input.priceMax,
    area_min: input.areaMin,
    area_max: input.areaMax,
    rooms: input.rooms,
    floor_min: input.floorMin,
    floor_max: input.floorMax,
    exclude_ground_floor: input.excludeGroundFloor,
    exclude_top_floor: input.excludeTopFloor,
    building_types: input.buildingTypes,
    ownership_types: input.ownershipTypes,
    market_type: input.marketType,
    private_only: input.privateOnly,
    max_price_per_sqm: input.maxPricePerSqm,
    required_keywords: input.requiredKeywords,
    excluded_keywords: input.excludedKeywords,
    min_flip_score: input.minFlipScore,
    min_estimated_profit: input.minEstimatedProfit,
    max_estimated_renovation_cost: input.maxEstimatedRenovationCost,
    scan_interval_minutes: input.scanIntervalMinutes,
    is_active: input.isActive,
  };
}

function toSearchFilter(row: Row): SearchFilter {
  return {
    id: requiredString(row.id, "ID"),
    name: requiredString(row.name, "Nazwa"),
    sources: stringArray(row.sources, "Źródła").filter(isListingSource),
    city: requiredString(row.city, "Miasto"),
    districts: stringArray(row.districts, "Dzielnice"),
    priceMin: nullableNumber(row.price_min, "price_min"),
    priceMax: nullableNumber(row.price_max, "price_max"),
    areaMin: nullableNumber(row.area_min, "area_min"),
    areaMax: nullableNumber(row.area_max, "area_max"),
    rooms: numberArray(row.rooms, "Pokoje"),
    floorMin: nullableNumber(row.floor_min, "floor_min"),
    floorMax: nullableNumber(row.floor_max, "floor_max"),
    excludeGroundFloor: booleanValue(row.exclude_ground_floor, "exclude_ground_floor"),
    excludeTopFloor: booleanValue(row.exclude_top_floor, "exclude_top_floor"),
    buildingTypes: stringArray(row.building_types, "Typy budynków"),
    ownershipTypes: stringArray(row.ownership_types, "Formy własności"),
    marketType: nullableMarketType(row.market_type),
    privateOnly: booleanValue(row.private_only, "private_only"),
    maxPricePerSqm: nullableNumber(row.max_price_per_sqm, "max_price_per_sqm"),
    requiredKeywords: stringArray(row.required_keywords, "Wymagane słowa"),
    excludedKeywords: stringArray(row.excluded_keywords, "Wykluczone słowa"),
    minFlipScore: nullableNumber(row.min_flip_score, "min_flip_score"),
    minEstimatedProfit: nullableNumber(row.min_estimated_profit, "min_estimated_profit"),
    maxEstimatedRenovationCost: nullableNumber(
      row.max_estimated_renovation_cost,
      "max_estimated_renovation_cost",
    ),
    scanIntervalMinutes: positiveInteger(row.scan_interval_minutes, "scan_interval_minutes"),
    isActive: booleanValue(row.is_active, "is_active"),
    lastScannedAt: nullableString(row.last_scanned_at),
    createdAt: requiredString(row.created_at, "created_at"),
    updatedAt: requiredString(row.updated_at, "updated_at"),
  };
}

function toSearchFilterScan(row: Row): SearchFilterScan | null {
  const id = asString(row.id);
  const searchFilterId = asString(row.search_filter_id);
  const source = asString(row.source);
  const status = asString(row.status);
  const startedAt = asString(row.started_at);

  if (
    !id ||
    !searchFilterId ||
    !source ||
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

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRow(value: unknown): Row {
  if (!isRow(value)) {
    throw new Error("Nieprawidłowa odpowiedź bazy danych.");
  }

  return value;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} jest wymagane.`);
  }

  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} musi być listą tekstową.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function numberArray(value: unknown, field: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error(`${field} musi być listą liczb.`);
  }

  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} musi być liczbą lub pustą wartością.`);
  }

  return value;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} musi być dodatnią liczbą całkowitą.`);
  }

  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} musi mieć wartość tak/nie.`);
  }

  return value;
}

function nullableMarketType(value: unknown): SearchFilter["marketType"] {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || !isMarketType(value)) {
    throw new Error("Rynek musi być pierwotny, wtórny lub oba.");
  }

  return value;
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
