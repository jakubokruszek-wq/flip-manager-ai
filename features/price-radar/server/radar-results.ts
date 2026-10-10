import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { dedupeByListingIdentity } from "@/features/listing-identity";
import { computeRadarStats } from "@/features/price-radar/stats";
import { DEFAULT_RADAR_DISTRICTS, type RadarFilters, type RadarListing, type RadarStatGroup } from "@/features/price-radar/types";
import { normalizeConfirmedPropertyIdentity } from "@/features/flip-finder/property-identity";

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
export async function getRadarResults(ownerId: string, filters: RadarFilters, supabase = createAdminClient()): Promise<RadarResultsPayload> {
  const districts = filters.districts.length > 0 ? filters.districts : [...DEFAULT_RADAR_DISTRICTS];
  const query = supabase
    .from("price_radar_listings")
    .select("id,owner_id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash,first_seen_at,last_seen_at,published_at,source_updated_at,collected_at,cross_source_identity,status,excluded_at,excluded_reason")
    .eq("owner_id", ownerId)
    .eq("status", "active")
    .in("district", districts)
    .order("last_seen_at", { ascending: false })
    .order("id", { ascending: true });

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
  const narrowedCandidates = deduped.filter((listing) => matchesNarrowFilters(listing, filters));
  const grouped = dedupeConfirmedCrossPortalIdentity(narrowedCandidates);
  const narrowed = filters.sources.length === 0 ? grouped : grouped.filter((listing) => filters.sources.includes(listing.source) || listing.crossSourceAlternates.some((alternate) => filters.sources.includes(alternate.source)));
  const visible = narrowed.filter((listing) => listing.excludedAt === null);
  const excludedListings = narrowed.filter((listing) => listing.excludedAt !== null);

  const stats = computeRadarStats(narrowed.map((listing) => ({
    district: listing.district,
    marketType: listing.marketType,
    qualityCategory: listing.qualityCategory,
    pricePerSqm: listing.pricePerSqm,
    lastSeenAt: listing.lastSeenAt,
    status: listing.status,
    excludedAt: listing.excludedAt,
  })));

  return { listings: visible, excludedListings, stats };
}

/** Cross-portal merging requires a source-provided, stable cross-reference. */
function dedupeConfirmedCrossPortalIdentity(listings: RadarListing[]): RadarListing[] {
  const groups = new Map<string, RadarListing[]>();
  for (const listing of listings) {
    if (!listing.crossSourceIdentity) {
      groups.set(`listing:${listing.id}`, [listing]);
      continue;
    }
    const key = `cross:${listing.crossSourceIdentity}`;
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
    const representative = [...group].sort((left, right) => completeness(right) - completeness(left) || left.source.localeCompare(right.source) || left.id.localeCompare(right.id))[0];
    representative.crossSourceAlternates = group.filter((listing) => listing.id !== representative.id).map((listing) => ({
      id: listing.id, source: listing.source, originalUrl: listing.originalUrl, title: listing.title,
      price: listing.price, area: listing.area, rooms: listing.rooms, publishedAt: listing.publishedAt,
      sourceUpdatedAt: listing.sourceUpdatedAt, collectedAt: listing.collectedAt,
    }));
    const excluded = group.filter((listing) => listing.excludedAt !== null).sort((left, right) => (right.excludedAt ?? "").localeCompare(left.excludedAt ?? ""))[0];
    if (excluded) {
      representative.excludedAt = excluded.excludedAt;
      representative.excludedReason = excluded.excludedReason;
    }
    kept.push(representative);
  }
  return kept;
}

function completeness(listing: RadarListing): number {
  return Number(Boolean(listing.title)) + Number(Boolean(listing.description)) + Number(Boolean(listing.rooms)) + Number(Boolean(listing.publishedAt)) + Number(Boolean(listing.sourceUpdatedAt));
}

function matchesNarrowFilters(listing: RadarListing, filters: RadarFilters): boolean {
  if (filters.market !== "both" && listing.marketType !== filters.market) return false;
  if (filters.areaMin !== null && listing.area < filters.areaMin) return false;
  if (filters.areaMax !== null && listing.area > filters.areaMax) return false;
  if (filters.rooms.length > 0 && (listing.rooms === null || !filters.rooms.includes(listing.rooms))) return false;
  if (filters.minPricePerSqm !== null && listing.pricePerSqm < filters.minPricePerSqm) return false;
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
  const publishedAt = nullableString(row.published_at);
  const sourceUpdatedAt = nullableString(row.source_updated_at);
  const collectedAt = nullableString(row.collected_at);
  const crossSourceIdentity = normalizeConfirmedPropertyIdentity(row.cross_source_identity);
  const status = row.status === "active" || row.status === "removed" ? row.status : null;

  if (!id || !source || !externalListingId || !originalUrl || !normalizedUrl || !city || !district || !buildingType || !marketType || !renovationStatus || price === null || area === null || pricePerSqm === null || !contentHash || !firstSeenAt || !lastSeenAt || !collectedAt || !status) {
    return null;
  }

  return {
    id, source: source as RadarListing["source"], externalListingId, originalUrl, normalizedUrl,
    title: nullableString(row.title), description: nullableString(row.description),
    price, area, pricePerSqm, rooms: nullableNumber(row.rooms), city, district, buildingType, marketType, renovationStatus,
    qualityCategory: marketType === "primary" || renovationStatus === "fresh_renovation" ? "fresh_renovation" : "ready_high_standard",
    contentHash, firstSeenAt, lastSeenAt, publishedAt, sourceUpdatedAt, collectedAt, crossSourceIdentity, crossSourceAlternates: [], status,
    excludedAt: nullableString(row.excluded_at), excludedReason: nullableString(row.excluded_reason),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
