import "server-only";

import type { ListingSource, SearchFilter } from "@/features/flip-finder";
import {
  isListingSource,
  isMarketType,
  type SearchFilterInput,
  type SearchFilterListBaseResponse,
  type SearchFilterScan,
} from "@/features/flip-finder/search-filter-contract";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isActiveFilterSource } from "@/features/flip-finder/source-availability";
import { FINDER_OLX_DEFAULT_INTERVAL_MINUTES, FINDER_OLX_DEFAULT_START_TIME, isFinderOlxIntervalMinutes, isFinderOlxStartTime, normalizeFinderOlxStartTime } from "@/features/flip-finder/finder-schedule";
import { isStaleScan, scanHeartbeatAt, selectLatestCompletedScans, selectLatestScans, SOURCE_SCAN_PAGE_LIMIT, STALE_SCAN_MESSAGE } from "./scan-lifecycle";

type Row = Record<string, unknown>;

/**
 * Carries the real Postgres/PostgREST error code and message so the API
 * route can return a specific, diagnostic response instead of always the
 * same generic "Nie udało się zapisać filtra." regardless of cause (a
 * permission error, a check-constraint violation, a missing environment
 * credential, etc. all looked identical to the operator before this).
 */
export class SearchFilterWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchFilterWriteError";
    this.code = code;
  }
}

/**
 * Builds the API response for any failure raised while creating/updating a
 * filter. Earlier, only a SearchFilterWriteError (the Postgres query itself
 * returning an {error}) was ever surfaced -- anything thrown before that
 * point, most importantly createAdminClient() itself throwing when a
 * required environment credential is missing, is a plain Error and was
 * silently flattened into the same opaque fallback message. Every Error
 * instance is now surfaced; this route is operator-authenticated only, so a
 * configuration or database error message is not exposed to the public.
 */
export function searchFilterWriteFailureResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof SearchFilterWriteError) {
    return Response.json({ message: `${fallbackMessage} (${error.code}): ${error.message}` }, { status: 500 });
  }
  if (error instanceof Error) {
    return Response.json({ message: `${fallbackMessage} ${error.message}` }, { status: 500 });
  }
  return Response.json({ message: fallbackMessage }, { status: 500 });
}

// filter_snapshot can be a large JSON document per scan; the list only needs
// its heartbeat, so only filter_snapshot->_scanProgress is projected.
const SOURCE_SCAN_COLUMNS: string =
  "id,scan_run_id,search_filter_id,source,status,started_at,finished_at,scanned_count,matched_count,listings_created,new_count,listings_updated,price_drop_count,warnings,error_message,scan_progress:filter_snapshot->_scanProgress";

type CountResult = { count?: number | null; error: unknown };

/**
 * Dashboard read. It used to download every listing_filter_matches row of
 * every filter (3854+ for "Flip" alone) and every listing (silently capped at
 * PostgREST's 1000 rows, so the summary was wrong past that size). It now
 * asks Postgres for exact counts only (HEAD requests, no rows returned).
 */
export async function listSearchFilters(): Promise<SearchFilterListBaseResponse> {
  const supabase = await createClient();
  const exactCount = (table: string) => supabase.from(table).select("id", { count: "exact", head: true });
  const membershipCount = () => supabase.from("listing_filter_matches").select("listing_id", { count: "exact", head: true });
  const [filtersResult, scansResult, completedScansResult, listingsTotal, activeListingsWithLifecycle, activeLegacyListings, removedListings] = await Promise.all([
    supabase.from("search_filters").select("*").order("updated_at", { ascending: false }),
    supabase.from("source_scans").select(SOURCE_SCAN_COLUMNS).order("started_at", { ascending: false }).limit(SOURCE_SCAN_PAGE_LIMIT),
    supabase.from("source_scans").select(SOURCE_SCAN_COLUMNS).eq("status", "completed").not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(SOURCE_SCAN_PAGE_LIMIT),
    exactCount("listings") as PromiseLike<CountResult>,
    exactCount("listings").eq("status", "active").eq("lifecycle_status", "ACTIVE") as PromiseLike<CountResult>,
    exactCount("listings").eq("status", "active").is("lifecycle_status", null) as PromiseLike<CountResult>,
    exactCount("listings").eq("status", "removed") as PromiseLike<CountResult>,
  ]);

  const countErrors = [listingsTotal, activeListingsWithLifecycle, activeLegacyListings, removedListings].map((result) => result.error).filter(Boolean);
  if (filtersResult.error || scansResult.error || completedScansResult.error || countErrors.length) {
    console.error("FLIP FINDER LIST ERROR:", filtersResult.error ?? scansResult.error ?? completedScansResult.error ?? countErrors[0]);
    throw new Error("Nie udało się pobrać filtrów.");
  }

  // Diagnostic counts of membership rows, before lifecycle, tombstone,
  // manual-decision, price, identity-grouping and filter-rule checks. The GET
  // route replaces totalMatches with the authoritative visible-card count.
  const filterRows = asRows(filtersResult.data).map(toSearchFilter);
  const membershipCounts = await Promise.all(filterRows.map(async (filter) => {
    const [all, current] = await Promise.all([
      membershipCount().eq("search_filter_id", filter.id) as PromiseLike<CountResult>,
      membershipCount().eq("search_filter_id", filter.id).eq("is_current_match", true) as PromiseLike<CountResult>,
    ]);
    if (all.error || current.error) {
      console.error("FLIP FINDER LIST MEMBERSHIP COUNT ERROR:", all.error ?? current.error);
      throw new Error("Nie udało się pobrać filtrów.");
    }
    return { all: all.count ?? 0, current: current.count ?? 0 };
  }));

  // The dashboard must never keep showing "running"/"pending" for a scan the
  // platform has already abandoned; this read-only projection is the backstop.
  const now = Date.now();
  const toScans = (data: unknown) => asRows(data).map((row) => toSearchFilterScan(row, now)).filter((scan): scan is SearchFilterScan => scan !== null);
  const scans = toScans(scansResult.data);
  const latestScans = selectLatestScans(scans);
  const latestCompletedScans = selectLatestCompletedScans(toScans(completedScansResult.data));

  const filters = filterRows.map((filter, index) => ({
    ...filter,
    currentMembershipRows: membershipCounts[index]?.current ?? 0,
    membershipRows: membershipCounts[index]?.all ?? 0,
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
      listingsCount: listingsTotal.count ?? 0,
      activeListings: (activeListingsWithLifecycle.count ?? 0) + (activeLegacyListings.count ?? 0),
      removedListings: removedListings.count ?? 0,
      newMatches: filters.reduce((total, filter) => total + filter.newMatches, 0),
    },
  };
}

export async function getSearchFilter(id: string, options: { supabase?: ReturnType<typeof createAdminClient>; signal?: AbortSignal } = {}): Promise<SearchFilter | null> {
  const supabase = options.supabase ?? await createClient();
  let query = supabase
    .from("search_filters")
    .select("*")
    .eq("id", id);
  if (options.signal) query = query.abortSignal(options.signal);
  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error("FLIP FINDER GET ERROR:", error);
    throw new Error("Nie udało się pobrać filtra.");
  }

  return data ? toSearchFilter(asRow(data)) : null;
}


/**
 * Server scheduler read path. Unlike the operator-facing getSearchFilter,
 * this deliberately uses the service-role client because a GitHub Actions
 * invocation has no browser session. It is read-only and is used only to
 * select active Finder filters before the existing scan reservation path
 * creates a run.
 */
export async function listActiveSearchFiltersForScheduler(): Promise<SearchFilter[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("search_filters")
    .select("*")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("FLIP FINDER SCHEDULER FILTER LIST ERROR:", error);
    throw new Error("Nie udało się pobrać aktywnych filtrów Findera.");
  }

  return asRows(data).map(toSearchFilter);
}

export async function getActiveSearchFiltersForSource(
  source: ListingSource,
): Promise<SearchFilter[]> {
  // Old filters may retain IDs that are registered but not approved for
  // runtime. Never hand those filters to a source worker. Facebook remains
  // valid here only for the independent Watcher/Collector path.
  if (!isActiveFilterSource(source)) {
    return [];
  }

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
  const supabase = createAdminClient();
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

  const requestedSources = stringArray(value.sources, "Źródła");
  const recognizedSources = requestedSources.filter(isListingSource);
  if (recognizedSources.length !== requestedSources.length) {
    throw new Error("Wybierz wyłącznie rozpoznawane źródła ofert.");
  }

  const input: SearchFilterInput = {
    name: requiredString(value.name, "Nazwa"),
    // Retain legacy IDs when reading saved filters, but never accept an
    // unavailable/disabled source as a new selection on create/update.
    sources: recognizedSources.filter(isActiveFilterSource),
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
    yearBuiltMin: nullableNumber(value.yearBuiltMin, "Rok budowy od"),
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
    finderScanIntervalMinutes: positiveInteger(value.finderScanIntervalMinutes ?? 60, "Interwał automatycznego skanu Findera"),
    finderOlxScanIntervalMinutes: finderOlxIntervalInput(value.finderOlxScanIntervalMinutes),
    finderOlxStartTime: finderOlxStartTimeInput(value.finderOlxStartTime),
    isActive: booleanValue(value.isActive, "Status"),
  };

  if (
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

  if (input.yearBuiltMin != null && (input.yearBuiltMin < 1700 || input.yearBuiltMin > 2100)) {
    throw new Error("Rok budowy od musi być w rozsądnym zakresie (1700–2100).");
  }

  return input;
}

async function writeSearchFilter(
  input: SearchFilterInput,
  id: string | null,
): Promise<SearchFilter | null> {
  const payload = toDatabasePayload(input);
  const supabase = createAdminClient();
  let { data, error } = await (id
    ? supabase.from("search_filters").update(payload).eq("id", id).select("*").maybeSingle()
    : supabase.from("search_filters").insert(payload).select("*").single());

  // The year_built_min, Finder cadence and OLX cadence migrations are drafts
  // until a human applies them. Until then, every existing field in the same
  // save must still go through; only the missing draft columns are omitted on
  // a safe compatibility retry. Never assume any of these migrations is live.
  const omitted = new Set<string>();
  for (let attempt = 0; attempt < DRAFT_COLUMNS.length; attempt += 1) {
    const missing = missingDraftColumns(error);
    if (!missing.length) break;
    missing.forEach((column) => omitted.add(column));
    const retryPayload = { ...payload } as Record<string, unknown>;
    omitted.forEach((column) => delete retryPayload[column]);
    ({ data, error } = await (id
      ? supabase.from("search_filters").update(retryPayload).eq("id", id).select("*").maybeSingle()
      : supabase.from("search_filters").insert(retryPayload).select("*").single()));
  }

  if (error) {
    console.error("FLIP FINDER WRITE ERROR:", error);
    throw new SearchFilterWriteError(error.code || "unknown", error.message);
  }

  return data ? toSearchFilter(asRow(data)) : null;
}

const DRAFT_COLUMNS = ["year_built_min", "finder_scan_interval_minutes", "finder_olx_scan_interval_minutes", "finder_olx_start_time"] as const;

/** Draft columns a PostgREST/Postgres "unknown column" error names (42703 / PGRST204 only). */
function missingDraftColumns(error: { code?: unknown; message?: unknown } | null): string[] {
  if (!error) return [];
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (code !== "42703" && code !== "PGRST204") return [];
  return DRAFT_COLUMNS.filter((column) => new RegExp(`\\b${column}\\b`).test(message));
}

function finderOlxIntervalInput(value: unknown): number {
  if (value === undefined || value === null) return FINDER_OLX_DEFAULT_INTERVAL_MINUTES;
  if (!isFinderOlxIntervalMinutes(value)) throw new Error("Interwał OLX: dozwolone wartości to 12 h, 24 h, 48 h albo 72 h.");
  return value;
}

function finderOlxStartTimeInput(value: unknown): string {
  if (value === undefined || value === null) return FINDER_OLX_DEFAULT_START_TIME;
  if (!isFinderOlxStartTime(value)) throw new Error("Godzina startu OLX: format HH:mm, co 5 minut (00:00–23:55).");
  return value;
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
    year_built_min: input.yearBuiltMin,
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
    finder_scan_interval_minutes: input.finderScanIntervalMinutes ?? 60,
    finder_olx_scan_interval_minutes: input.finderOlxScanIntervalMinutes ?? FINDER_OLX_DEFAULT_INTERVAL_MINUTES,
    finder_olx_start_time: input.finderOlxStartTime ?? FINDER_OLX_DEFAULT_START_TIME,
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
    // Tolerates the column being entirely absent (undefined), not just a SQL
    // NULL -- year_built_min's own migration (draft, not yet applied) may
    // not exist on this row's table yet, and "not applied" must read the
    // same as "never set" (null), never throw and break every filter read.
    yearBuiltMin: nullableNumberOrMissingColumn(row.year_built_min),
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
    finderScanIntervalMinutes: positiveIntegerOrDefault(row.finder_scan_interval_minutes, 60, "finder_scan_interval_minutes"),
    // Absent column (migration not applied) or an unexpected value reads as
    // null, never as the default: the OLX scheduler then queues nothing.
    finderOlxScanIntervalMinutes: isFinderOlxIntervalMinutes(row.finder_olx_scan_interval_minutes) ? row.finder_olx_scan_interval_minutes : null,
    finderOlxStartTime: normalizeFinderOlxStartTime(row.finder_olx_start_time),
    isActive: booleanValue(row.is_active, "is_active"),
    lastScannedAt: nullableString(row.last_scanned_at),
    createdAt: requiredString(row.created_at, "created_at"),
    updatedAt: requiredString(row.updated_at, "updated_at"),
  };
}

export function toSearchFilterScan(row: Row, now: number): SearchFilterScan | null {
  const id = asString(row.id);
  const searchFilterId = asString(row.search_filter_id);
  const source = asString(row.source);
  const rawStatus = asString(row.status);
  const startedAt = asString(row.started_at);

  if (
    !id ||
    !searchFilterId ||
    !source ||
    !isListingSource(source) ||
    !isSearchFilterScanStatus(rawStatus) ||
    !startedAt
  ) {
    return null;
  }

  // Facebook/OLX rows have their own dedicated watchdogs (the Watcher
  // scheduler and the OLX lease recovery respectively) that already run on
  // their own schedules independent of this dashboard read -- reclassifying
  // them here too would risk disagreeing with whichever one of those is
  // currently mid-recovery for the exact same row.
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

/**
 * Like nullableNumber, but for mapping a DB row's own column rather than
 * validating request input: `undefined` (the column does not exist on this
 * row at all) is treated exactly like `null` (the column exists but was
 * never set) instead of throwing. Only year_built_min uses this today --
 * every other column here has existed since the foundation migration, so
 * `undefined` for them would be a genuine bug worth nullableNumber's throw,
 * not a column that is still only a draft migration away from existing.
 */
function nullableNumberOrMissingColumn(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function positiveIntegerOrDefault(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  return positiveInteger(value, field);
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
