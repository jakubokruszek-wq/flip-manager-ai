import "server-only";

import { chunkArray } from "./chunk-array";
import { preferredListingUrl } from "./comparable-url";
import { selectComparableListings, streetKey } from "./comparable-listings";
import { average, calculatePriceStatistics, percentileRank } from "./statistics";
import type { MarketIntelligence, MarketListing, MarketType } from "./types";
import { estimateAfterRenovationValue } from "./valuation";
import { createClient } from "@/lib/supabase/server";
import { resolveLocation } from "@/features/location-intelligence/resolve-location";
import type { LocationResolution } from "@/features/location-intelligence/types";

type Row = Record<string, unknown>;
type BatchResult = { data: unknown; error: { message: string } | null };

const LOOKBACK_DAYS = 90;
const MAX_CANDIDATES = 250;
const BATCH_SIZE = 75;

export async function analyzeMarket(listingId: string): Promise<MarketIntelligence | null> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const subjectResult = await supabase
    .from("listings")
    .select("id,title,description,original_url,normalized_url,price,area,price_per_sqm,rooms,address,district,city,source,status,last_seen_at")
    .eq("id", listingId)
    .maybeSingle();

  if (subjectResult.error) {
    console.error("MARKET INTELLIGENCE SUBJECT ERROR:", subjectResult.error);
    throw new Error("Nie udało się pobrać analizowanej oferty.");
  }

  const subjectRow = asRow(subjectResult.data);
  if (!subjectRow) return null;

  const candidatesResult = await candidateQuery(supabase, subjectRow, cutoff);
  if (candidatesResult.error) {
    console.error("MARKET INTELLIGENCE CANDIDATES ERROR:", candidatesResult.error);
    throw new Error("Nie udało się pobrać ofert porównywalnych.");
  }

  const listingRows = uniqueRowsBy([subjectRow, ...asRows(candidatesResult.data)], "id");
  const listingIds = uniqueStrings(listingRows.map((row) => stringValue(row.id)));
  const matches = await fetchRowsInBatches(
    listingIds,
    "dopasowań filtrów",
    (ids) =>
      supabase
        .from("listing_filter_matches")
        .select("listing_id,search_filter_id")
        .in("listing_id", ids)
        .eq("is_current_match", true),
    (row) => `${stringValue(row.listing_id) ?? ""}:${stringValue(row.search_filter_id) ?? ""}`,
  );
  const filterIds = uniqueStrings(matches.map((row) => stringValue(row.search_filter_id)));
  const filters = await fetchRowsInBatches(
    filterIds,
    "kontekstu rynku filtrów",
    (ids) => supabase.from("search_filters").select("id,market_type").in("id", ids),
    (row) => stringValue(row.id) ?? "",
  );
  const marketTypesByListing = marketTypesForListings(matches, filters);
  const preliminaryListings = listingRows
    .map((row) => toMarketListing(row, new Map(), marketTypesByListing))
    .filter((listing): listing is MarketListing => listing !== null);
  const preliminarySubject = preliminaryListings.find((listing) => listing.id === listingId);
  if (!preliminarySubject) return null;

  const preliminaryCandidates = preliminaryListings.filter((listing) => listing.id !== preliminarySubject.id);
  const resolvedLocations = await resolveListingLocations(preliminaryListings);
  const preliminaryComparables = selectComparableListings(preliminarySubject, preliminaryCandidates, resolvedLocations);
  const snapshotListingIds = uniqueStrings([preliminarySubject.id, ...preliminaryComparables.map((listing) => listing.id)]);
  const snapshots = await fetchRowsInBatches(
    snapshotListingIds,
    "snapshotów cen",
    (ids) =>
      supabase
        .from("listing_snapshots")
        .select("listing_id,price,captured_at")
        .in("listing_id", ids)
        .order("captured_at", { ascending: false }),
    (row) => `${stringValue(row.listing_id) ?? ""}:${stringValue(row.captured_at) ?? ""}`,
  );
  const latestSnapshotPriceByListing = latestSnapshotPrices(snapshots);
  const listings = listingRows
    .map((row) => toMarketListing(row, latestSnapshotPriceByListing, marketTypesByListing))
    .filter((listing): listing is MarketListing => listing !== null);
  const subject = listings.find((listing) => listing.id === listingId);
  if (!subject) return null;

  const candidates = listings.filter((listing) => listing.id !== subject.id);
  const listingsById = new Map(listings.map((listing) => [listing.id, listing]));
  const comparables = preliminaryComparables.flatMap((comparable) => {
    const listing = listingsById.get(comparable.id);
    return listing ? [{ ...comparable, price: listing.price, pricePerSqm: listing.pricePerSqm }] : [];
  });
  const comparablePricesPerSqm = comparables.flatMap((listing) =>
    isPositiveFinite(listing.pricePerSqm) ? [listing.pricePerSqm] : [],
  );
  const statistics = calculatePriceStatistics(comparablePricesPerSqm);
  const districtAverage = average(
    candidates
      .filter((listing) => sameLocation(listing.district, subject.district))
      .map((listing) => listing.pricePerSqm),
  );
  const subjectStreet = streetKey(subject.address, subject.district, subject.city);
  const streetAverage = average(
    candidates
      .filter((listing) => subjectStreet !== null && streetKey(listing.address, listing.district, listing.city) === subjectStreet)
      .map((listing) => listing.pricePerSqm),
  );
  const currentPricePerSqm = subject.pricePerSqm;
  const priceDifference = currentPricePerSqm !== null && statistics.average !== null ? currentPricePerSqm - statistics.average : null;
  const ranking = currentPricePerSqm !== null && comparablePricesPerSqm.length ? comparablePricesPerSqm.filter((value) => value < currentPricePerSqm).length + 1 : null;

  return {
    listingId: subject.id,
    districtAverage,
    streetAverage,
    averagePricePerSqm: statistics.average,
    median: statistics.median,
    q1: statistics.q1,
    q3: statistics.q3,
    min: statistics.min,
    max: statistics.max,
    standardDeviation: statistics.standardDeviation,
    currentPrice: subject.price,
    currentPricePerSqm,
    ...estimateAfterRenovationValue(subject.price, subject.area, statistics),
    priceDifference,
    percentageDifference: priceDifference !== null && statistics.average !== null && statistics.average > 0 ? (priceDifference / statistics.average) * 100 : null,
    ranking,
    percentile: percentileRank(comparablePricesPerSqm, currentPricePerSqm),
    comparableCount: comparables.length,
    comparables,
  };
}

async function resolveListingLocations(listings: MarketListing[]): Promise<Map<string, LocationResolution>> {
  const entries = await Promise.all(listings.map(async (listing) => {
    const location = await resolveLocation({
      address: listing.address,
      street: null,
      district: listing.district,
      city: listing.city,
      locationText: [listing.address, listing.district, listing.city].filter(Boolean).join(", ") || null,
      title: listing.title,
      description: listing.description,
    });
    return [listing.id, location] as const;
  }));
  return new Map(entries);
}

async function candidateQuery(supabase: Awaited<ReturnType<typeof createClient>>, subject: Row, cutoff: string) {
  let query = supabase
    .from("listings")
    .select("id,title,description,original_url,normalized_url,price,area,price_per_sqm,rooms,address,district,city,source,status,last_seen_at")
    .eq("status", "active")
    .gte("last_seen_at", cutoff)
    .neq("id", stringValue(subject.id) ?? "")
    .order("last_seen_at", { ascending: false })
    .limit(MAX_CANDIDATES);
  const city = stringValue(subject.city);
  const district = stringValue(subject.district);
  const area = numberValue(subject.area);
  if (city) query = query.eq("city", city);
  else if (district) query = query.eq("district", district);
  if (isPositiveFinite(area)) query = query.gte("area", Math.max(0, area - 20)).lte("area", area + 20);
  return query;
}

async function fetchRowsInBatches(
  ids: string[],
  label: string,
  fetchBatch: (ids: string[]) => PromiseLike<BatchResult>,
  rowKey: (row: Row) => string,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, idsBatch] of chunkArray(uniqueStrings(ids), BATCH_SIZE).entries()) {
    let result: BatchResult;
    try {
      result = await fetchBatch(idsBatch);
    } catch (error) {
      console.error(`MARKET INTELLIGENCE ${label.toUpperCase()} BATCH ${index + 1} ERROR:`, error);
      throw new Error(`Nie udało się pobrać ${label} (paczka ${index + 1}).`);
    }
    if (result.error) {
      console.error(`MARKET INTELLIGENCE ${label.toUpperCase()} BATCH ${index + 1} ERROR:`, result.error);
      throw new Error(`Nie udało się pobrać ${label} (paczka ${index + 1}).`);
    }
    rows.push(...asRows(result.data));
  }
  return uniqueRowsBy(rows, rowKey);
}

function latestSnapshotPrices(rows: Row[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const row of rows) {
    const listingId = stringValue(row.listing_id);
    const price = numberValue(row.price);
    if (listingId && price !== null && !prices.has(listingId)) prices.set(listingId, price);
  }
  return prices;
}

function marketTypesForListings(matches: Row[], filters: Row[]): Map<string, MarketType[]> {
  const marketTypeByFilter = new Map(filters.flatMap((filter) => {
    const id = stringValue(filter.id);
    const marketType = marketTypeValue(filter.market_type);
    return id && marketType ? [[id, marketType] as const] : [];
  }));
  const marketTypesByListing = new Map<string, Set<MarketType>>();
  for (const match of matches) {
    const listingId = stringValue(match.listing_id);
    const marketType = marketTypeByFilter.get(stringValue(match.search_filter_id) ?? "");
    if (!listingId || !marketType) continue;
    const types = marketTypesByListing.get(listingId) ?? new Set<MarketType>();
    types.add(marketType);
    marketTypesByListing.set(listingId, types);
  }
  return new Map([...marketTypesByListing].map(([id, types]) => [id, [...types]]));
}

function toMarketListing(row: Row, snapshotPrices: Map<string, number>, marketTypesByListing: Map<string, MarketType[]>): MarketListing | null {
  const id = stringValue(row.id);
  const source = stringValue(row.source);
  const status = stringValue(row.status);
  const lastSeenAt = stringValue(row.last_seen_at);
  if (!id || !source || !status || !lastSeenAt) return null;
  const price = numberValue(row.price) ?? snapshotPrices.get(id) ?? null;
  const area = numberValue(row.area);
  const storedPricePerSqm = numberValue(row.price_per_sqm);
  const normalizedUrl = stringValue(row.normalized_url);
  const originalUrl = preferredListingUrl(stringValue(row.original_url), normalizedUrl, source, id);
  return { id, title: stringValue(row.title), description: stringValue(row.description), originalUrl, normalizedUrl, price, area, pricePerSqm: storedPricePerSqm ?? (isPositiveFinite(price) && isPositiveFinite(area) ? price / area : null), rooms: numberValue(row.rooms), address: stringValue(row.address), district: stringValue(row.district), city: stringValue(row.city), source, status, lastSeenAt, marketTypes: marketTypesByListing.get(id) ?? [] };
}


function uniqueRowsBy(rows: Row[], key: string | ((row: Row) => string)): Row[] {
  const seen = new Set<string>();
  const keyFor = typeof key === "string" ? (row: Row) => stringValue(row[key]) ?? "" : key;
  return rows.filter((row) => { const value = keyFor(row); if (!value || seen.has(value)) return false; seen.add(value); return true; });
}
function uniqueStrings(values: Array<string | null>): string[] { return [...new Set(values.filter((value): value is string => Boolean(value)))]; }
function sameLocation(left: string | null, right: string | null): boolean { return Boolean(left && right && left.trim().toLocaleLowerCase("pl-PL") === right.trim().toLocaleLowerCase("pl-PL")); }
function asRows(value: unknown): Row[] { return Array.isArray(value) ? value.filter(isRow) : []; }
function asRow(value: unknown): Row | null { return isRow(value) ? value : null; }
function isRow(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function marketTypeValue(value: unknown): MarketType | null { return value === "primary" || value === "secondary" ? value : null; }
function isPositiveFinite(value: number | null): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
