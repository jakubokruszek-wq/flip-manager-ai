import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualifiedListing } from "@/features/price-radar/qualification";

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
  rawPayload: Record<string, unknown>;
};

/**
 * Upserts one already-qualified Radar listing. A re-collection that
 * re-confirms the same (source, externalListingId) updates price/area/text
 * and bumps last_seen_at, but never touches excluded_at/excluded_reason --
 * an operator's exclusion is Radar's own sticky decision, independent of
 * whatever a later collection run observes. Mirrors persist-listing.ts's own
 * "preserve what a re-scan doesn't confirm" principle, applied to exclusion
 * instead of buildingType/ownership.
 */
export async function persistRadarListing(
  supabase: SupabaseClient,
  candidate: RadarPersistCandidate,
  seenAt: string,
  signal?: AbortSignal,
): Promise<{ listingId: string; created: boolean }> {
  let existingQuery = supabase
    .from("price_radar_listings")
    .select("id")
    .eq("source", candidate.source)
    .eq("external_listing_id", candidate.externalListingId);
  if (signal) existingQuery = existingQuery.abortSignal(signal);
  const existing = await existingQuery.maybeSingle();
  if (existing.error) throw new Error("Nie udało się sprawdzić istniejącej oferty Radaru.");

  const values = {
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
    last_seen_at: seenAt,
    status: "active",
    raw_payload: candidate.rawPayload,
  };

  let upsertQuery = supabase
    .from("price_radar_listings")
    .upsert(values, { onConflict: "source,external_listing_id" })
    .select("id");
  if (signal) upsertQuery = upsertQuery.abortSignal(signal);
  const { data, error } = await upsertQuery.single();
  if (error || !data || typeof data.id !== "string") throw new Error("Nie udało się zapisać oferty Radaru.");
  return { listingId: data.id, created: !existing.data };
}
