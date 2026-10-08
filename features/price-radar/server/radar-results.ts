import "server-only";

import { createClient } from "@/lib/supabase/server";
import { dedupeByListingIdentity } from "@/features/listing-identity";
import { computeRadarStats } from "@/features/price-radar/stats";
import { DEFAULT_RADAR_DISTRICTS, type RadarFilters, type RadarListing, type RadarStatGroup } from "@/features/price-radar/types";

type Row = Record<string, unknown>;

export type RadarResultsPayload = {
  listings: RadarListing[];
  excludedListings: RadarListing[];
  stats: RadarStatGroup[];
};

/**
 * Reads every active, not-yet-removed Radar listing for the requested
 * districts/sources (status filtering happens here; market/area/room
 * narrowing and exclusion-visibility are applied after dedup so the
 * statistics and the dedup pass both see the same confirmed-duplicate-free
 * population the filters describe). Cross-portal duplicates are resolved
 * by the SAME dedupeByListingIdentity Finder and Watcher already use --
 * confirmed externalListingId/URL identity only, never a shared catalog
 * URL or a similar title/address (see listing-identity.ts).
 */
export async function getRadarResults(filters: RadarFilters): Promise<RadarResultsPayload> {
  const supabase = await createClient();
  const districts = filters.districts.length > 0 ? filters.districts : [...DEFAULT_RADAR_DISTRICTS];
  let query = supabase
    .from("price_radar_listings")
    .select("id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash,first_seen_at,last_seen_at,status,excluded_at,excluded_reason")
    .eq("status", "active")
    .in("district", districts)
    .order("id", { ascending: true });
  if (filters.sources.length > 0) query = query.in("source", filters.sources);

  const rows: Row[] = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await query.range(start, start + pageSize - 1);
    if (error) throw new Error("Nie udało się pobrać ofert Radaru.");
    const page = asRows(data);
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const allListings = rows.map(toRadarListing).filter((listing): listing is RadarListing => listing !== null);
  // Within one portal: the same proven identity resolution Finder/Watcher
  // use (confirmed externalListingId/URL). Its keys are source-prefixed, so
  // this alone never merges across different portals.
  const deduped = dedupeByListingIdentity(allListings, (listing) => ({
    listingId: listing.id,
    source: listing.source,
    externalListingId: listing.externalListingId,
    originalUrl: listing.originalUrl,
  }));
  const crossPortalDeduped = dedupeCrossPortal(deduped);

  const narrowed = crossPortalDeduped.filter((listing) => matchesNarrowFilters(listing, filters));
  const visible = narrowed.filter((listing) => listing.excludedAt === null);
  const excludedListings = narrowed.filter((listing) => listing.excludedAt !== null);

  const stats = computeRadarStats(narrowed.map((listing) => ({
    district: listing.district,
    marketType: listing.marketType,
    pricePerSqm: listing.pricePerSqm,
    lastSeenAt: listing.lastSeenAt,
    status: listing.status,
    excludedAt: listing.excludedAt,
  })));

  return { listings: visible, excludedListings, stats };
}

/**
 * Cross-portal duplicates (the same real apartment listed on two different
 * sites) have no shared ID or URL to confirm them by -- real estate portals
 * expose none. Rather than merge by title or address text (explicitly
 * forbidden: two different apartments can share a near-identical title or
 * building address), this only collapses listings whose price, area,
 * district and room count are ALL exactly identical -- a coincidence real
 * enough to require positive evidence, but conservative enough that it
 * never fires on "similar", only on exact figures across every field a
 * genuinely different apartment would almost certainly differ on in at
 * least one. The earliest-discovered listing (by firstSeenAt) is kept.
 */
function dedupeCrossPortal(listings: RadarListing[]): RadarListing[] {
  const groups = new Map<string, RadarListing[]>();
  for (const listing of listings) {
    const key = `${listing.price}|${listing.area}|${listing.district}|${listing.rooms ?? "null"}`;
    const group = groups.get(key) ?? [];
    group.push(listing);
    groups.set(key, group);
  }
  const kept: RadarListing[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sourcesInGroup = new Set(group.map((listing) => listing.source));
    if (sourcesInGroup.size === 1) {
      // Same portal, same exact figures but somehow not caught by identity
      // dedup above (e.g. a portal re-issuing a new externalListingId) --
      // out of scope for cross-portal collapsing; keep all, identity dedup
      // already did its job for genuine within-source duplicates.
      kept.push(...group);
      continue;
    }
    const earliest = group.reduce((current, listing) => (listing.firstSeenAt < current.firstSeenAt ? listing : current));
    kept.push(earliest);
  }
  return kept;
}

function matchesNarrowFilters(listing: RadarListing, filters: RadarFilters): boolean {
  if (filters.market !== "both" && listing.marketType !== filters.market) return false;
  if (filters.areaMin !== null && listing.area < filters.areaMin) return false;
  if (filters.areaMax !== null && listing.area > filters.areaMax) return false;
  if (filters.rooms.length > 0 && (listing.rooms === null || !filters.rooms.includes(listing.rooms))) return false;
  return true;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
}

function toRadarListing(row: Row): RadarListing | null {
  const id = nullableString(row.id);
  const source = nullableString(row.source);
  const externalListingId = nullableString(row.external_listing_id);
  const originalUrl = nullableString(row.original_url);
  const normalizedUrl = nullableString(row.normalized_url);
  const city = nullableString(row.city);
  const district = nullableString(row.district);
  const buildingType = row.building_type === "blok" || row.building_type === "apartamentowiec" ? row.building_type : null;
  const marketType = row.market_type === "primary" || row.market_type === "secondary" ? row.market_type : null;
  const renovationStatus = row.renovation_status === "fresh_renovation" || row.renovation_status === "turnkey_finish" ? row.renovation_status : null;
  const price = nullableNumber(row.price);
  const area = nullableNumber(row.area);
  const pricePerSqm = nullableNumber(row.price_per_sqm);
  const contentHash = nullableString(row.content_hash);
  const firstSeenAt = nullableString(row.first_seen_at);
  const lastSeenAt = nullableString(row.last_seen_at);
  const status = row.status === "active" || row.status === "removed" ? row.status : null;

  if (!id || !source || !externalListingId || !originalUrl || !normalizedUrl || !city || !district || !buildingType || !marketType || !renovationStatus || price === null || area === null || pricePerSqm === null || !contentHash || !firstSeenAt || !lastSeenAt || !status) {
    return null;
  }

  return {
    id, source: source as RadarListing["source"], externalListingId, originalUrl, normalizedUrl,
    title: nullableString(row.title), description: nullableString(row.description),
    price, area, pricePerSqm, rooms: nullableNumber(row.rooms), city, district, buildingType, marketType, renovationStatus,
    contentHash, firstSeenAt, lastSeenAt, status,
    excludedAt: nullableString(row.excluded_at), excludedReason: nullableString(row.excluded_reason),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
