import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualifiedListing } from "@/features/price-radar/qualification";
import { normalizeConfirmedPropertyIdentity } from "@/features/flip-finder/property-identity";
import { compareRadarIdentitySnapshots } from "@/features/price-radar/own-listing-consistency";

export type RadarPersistCandidate = QualifiedListing & {
  source: string;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number;
  area: number;
  rooms: number | null;
  city: string;
  contentHash: string;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  crossSourceIdentity: string | null;
  rawPayload: Record<string, unknown>;
};

/**
 * A conflicting detail response is rejected before normal qualification and
 * therefore never reaches persistRadarListing. If the same portal identity
 * already has an active saved row, attach the exact conflict marker to that
 * old snapshot through the lease-fenced RPC. Never replace its dwelling facts
 * or touch a manual exclusion.
 */
export async function markExistingRadarListingForReview(
  supabase: SupabaseClient,
  input: { ownerId: string; runId: string; leaseToken: string; seenAt: string },
  identity: { source: string; externalListingId: string; issueFields: readonly string[] },
  signal?: AbortSignal,
): Promise<string | null> {
  const issueFields = [...new Set(identity.issueFields.filter((field) => ["area", "rooms", "floor", "location"].includes(field)))];
  if (!issueFields.length) return null;
  let query = supabase.from("price_radar_listings")
    .select("id,owner_id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash,published_at,source_updated_at,cross_source_identity,raw_payload,status,excluded_at,excluded_reason")
    .eq("owner_id", input.ownerId)
    .eq("source", identity.source)
    .eq("external_listing_id", identity.externalListingId);
  if (signal && "abortSignal" in query && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("Nie udało się zweryfikować tożsamości oferty Radaru.");
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const existing = data as Record<string, unknown>;
  const existingId = stringOrNull(existing.id);
  if (existing.status !== "active" || existing.excluded_at !== null || !existingId) return existingId;

  const oldPrice = numberOrNull(existing.price);
  const oldArea = numberOrNull(existing.area);
  const oldContentHash = stringOrNull(existing.content_hash);
  const oldOriginalUrl = stringOrNull(existing.original_url);
  const oldNormalizedUrl = stringOrNull(existing.normalized_url);
  if (oldPrice === null || oldArea === null || oldArea <= 0 || !oldContentHash || !oldOriginalUrl || !oldNormalizedUrl) return existingId;

  const oldRaw = asRecord(existing.raw_payload);
  const oldListing = {
    source: identity.source,
    external_listing_id: stringOrNull(existing.external_listing_id) ?? identity.externalListingId,
    original_url: oldOriginalUrl,
    normalized_url: oldNormalizedUrl,
    title: stringOrNull(existing.title),
    description: stringOrNull(existing.description),
    price: oldPrice,
    area: oldArea,
    price_per_sqm: numberOrNull(existing.price_per_sqm) ?? oldPrice / oldArea,
    rooms: numberOrNull(existing.rooms),
    city: stringOrNull(existing.city),
    district: stringOrNull(existing.district),
    building_type: stringOrNull(existing.building_type),
    market_type: stringOrNull(existing.market_type),
    renovation_status: stringOrNull(existing.renovation_status),
    content_hash: oldContentHash,
    published_at: stringOrNull(existing.published_at),
    source_updated_at: stringOrNull(existing.source_updated_at),
    cross_source_identity: stringOrNull(existing.cross_source_identity),
    collected_at: input.seenAt,
    last_seen_at: input.seenAt,
    raw_payload: { ...oldRaw, identityVerificationIssues: [...new Set([...(stringArray(oldRaw.identityVerificationIssues)), ...issueFields])] },
  };
  return persistWithLease(supabase, oldListing, input, signal);
}

/**
 * Persistence is a single SECURITY DEFINER RPC so the database checks the
 * current run lease and writes the snapshot in one transaction. A worker
 * whose lease was replaced cannot write even if it finishes a portal fetch
 * late. The RPC updates by stable source ID or same-source normalized URL;
 * cross-source identity is data for read-side exact-proof grouping only.
 */
export async function persistRadarListing(
  supabase: SupabaseClient,
  candidate: RadarPersistCandidate,
  input: { ownerId: string; runId: string; leaseToken: string; seenAt: string },
  signal?: AbortSignal,
): Promise<{ listingId: string; identityConflictFields?: string[] }> {
  const existingQuery = supabase.from("price_radar_listings")
    .select("id,owner_id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash,published_at,source_updated_at,cross_source_identity,raw_payload,status,excluded_at,excluded_reason")
    .eq("owner_id", input.ownerId)
    .eq("source", candidate.source)
    .eq("external_listing_id", candidate.externalListingId);
  const existingQueryWithSignal = signal && "abortSignal" in existingQuery && typeof existingQuery.abortSignal === "function"
    ? existingQuery.abortSignal(signal)
    : existingQuery;
  const { data: existingRow, error: readError } = await existingQueryWithSignal.maybeSingle();
  if (readError) throw new Error("Nie udało się zweryfikować tożsamości oferty Radaru.");

  if (existingRow && typeof existingRow === "object" && !Array.isArray(existingRow)) {
    const existing = existingRow as Record<string, unknown>;
    const oldRaw = asRecord(existing.raw_payload);
    const oldEvidence = asRecord(oldRaw.detailEvidence);
    const newEvidence = asRecord(candidate.rawPayload.detailEvidence);
    const identityConflictFields = compareRadarIdentitySnapshots({
      area: numberOrNull(existing.area),
      rooms: numberOrNull(existing.rooms),
      floor: numberOrNull(oldEvidence.floor),
      locationText: stringOrNull(oldEvidence.locationText) ?? stringOrNull(oldRaw.detailLocationText),
    }, {
      area: candidate.area,
      rooms: candidate.rooms,
      floor: numberOrNull(newEvidence.floor),
      locationText: stringOrNull(newEvidence.locationText) ?? stringOrNull(candidate.rawPayload.detailLocationText),
    });
    if (identityConflictFields.length > 0) {
      // Keep the old dwelling snapshot and its manual exclusion intact. For an
      // active row, attach only a review marker through the same lease-fenced
      // RPC, so the read path can keep it visible but out of A/B statistics.
      if (existing.status === "active" && existing.excluded_at === null) {
        const oldPrice = numberOrNull(existing.price);
        const oldArea = numberOrNull(existing.area);
        const oldContentHash = stringOrNull(existing.content_hash);
        const oldOriginalUrl = stringOrNull(existing.original_url);
        const oldNormalizedUrl = stringOrNull(existing.normalized_url);
        if (oldPrice !== null && oldArea !== null && oldArea > 0 && oldContentHash && oldOriginalUrl && oldNormalizedUrl) {
          const oldListing = {
            source: candidate.source,
            external_listing_id: stringOrNull(existing.external_listing_id) ?? candidate.externalListingId,
            original_url: oldOriginalUrl,
            normalized_url: oldNormalizedUrl,
            title: stringOrNull(existing.title),
            description: stringOrNull(existing.description),
            price: oldPrice,
            area: oldArea,
            price_per_sqm: numberOrNull(existing.price_per_sqm) ?? oldPrice / oldArea,
            rooms: numberOrNull(existing.rooms),
            city: stringOrNull(existing.city) ?? candidate.city,
            district: stringOrNull(existing.district) ?? candidate.district,
            building_type: stringOrNull(existing.building_type) ?? candidate.buildingType,
            market_type: stringOrNull(existing.market_type) ?? candidate.marketType,
            renovation_status: stringOrNull(existing.renovation_status) ?? candidate.renovationStatus,
            content_hash: oldContentHash,
            published_at: stringOrNull(existing.published_at),
            source_updated_at: stringOrNull(existing.source_updated_at),
            cross_source_identity: stringOrNull(existing.cross_source_identity),
            collected_at: input.seenAt,
            last_seen_at: input.seenAt,
            raw_payload: { ...oldRaw, identityVerificationIssues: [...new Set([...(stringArray(oldRaw.identityVerificationIssues)), ...identityConflictFields])] },
          };
          const markerSavedId = await persistWithLease(supabase, oldListing, input, signal);
          return { listingId: markerSavedId, identityConflictFields };
        }
      }
      return { listingId: stringOrNull(existing.id) ?? "", identityConflictFields };
    }
  }

  const payload = {
    source: candidate.source,
    external_listing_id: candidate.externalListingId,
    original_url: candidate.originalUrl,
    normalized_url: candidate.normalizedUrl,
    title: candidate.title,
    description: candidate.description,
    price: candidate.price,
    area: candidate.area,
    price_per_sqm: candidate.pricePerSqm,
    rooms: candidate.rooms,
    city: candidate.city,
    district: candidate.district,
    building_type: candidate.buildingType,
    market_type: candidate.marketType,
    renovation_status: candidate.renovationStatus,
    content_hash: candidate.contentHash,
    published_at: candidate.publishedAt,
    source_updated_at: candidate.sourceUpdatedAt,
    cross_source_identity: normalizeConfirmedPropertyIdentity(candidate.crossSourceIdentity),
    collected_at: input.seenAt,
    last_seen_at: input.seenAt,
    raw_payload: candidate.rawPayload,
  };
  return { listingId: await persistWithLease(supabase, payload, input, signal) };
}

async function persistWithLease(supabase: SupabaseClient, payload: Record<string, unknown>, input: { ownerId: string; runId: string; leaseToken: string; seenAt: string }, signal?: AbortSignal): Promise<string> {
  let query = supabase.rpc("persist_price_radar_listing", {
    p_owner_id: input.ownerId,
    p_run_id: input.runId,
    p_lease_token: input.leaseToken,
    p_listing: payload,
  });
  if (signal && "abortSignal" in query && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error || typeof data !== "string") throw new Error(error?.message === "RADAR_LEASE_LOST" ? "RADAR_LEASE_LOST" : "Nie udało się zapisać oferty Radaru.");
  return data;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
