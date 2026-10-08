import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualifiedListing } from "@/features/price-radar/qualification";
import { normalizeConfirmedPropertyIdentity } from "@/features/flip-finder/property-identity";

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
): Promise<{ listingId: string }> {
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
  let query = supabase.rpc("persist_price_radar_listing", {
    p_owner_id: input.ownerId,
    p_run_id: input.runId,
    p_lease_token: input.leaseToken,
    p_listing: payload,
  });
  if (signal && "abortSignal" in query && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error || typeof data !== "string") throw new Error(error?.message === "RADAR_LEASE_LOST" ? "RADAR_LEASE_LOST" : "Nie udało się zapisać oferty Radaru.");
  return { listingId: data };
}
