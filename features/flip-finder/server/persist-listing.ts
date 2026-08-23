import "server-only";

import { resolveListingImages } from "@/features/flip-finder/listing-images";
import { isPriceDrop, needsSnapshot } from "@/features/flip-finder/otodom-search";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { PropertyListing } from "@/features/properties/types/property";
import type { SupabaseClient } from "@supabase/supabase-js";

type ExistingListing = Pick<PropertyListing, "id" | "price" | "contentHash" | "images">;

export async function persistListing(supabase: SupabaseClient, filterId: string, item: SourceListing, createMatch: boolean, unknownFields: string[], sourceScanId: string, matchedAt: string, signal: AbortSignal): Promise<{ listingId: string; listingCreated: boolean; matchCreated: boolean; updated: number; priceDrop: number }> {
  const { data: existing, error: existingError } = await supabase.from("listings").select("id,price,content_hash,images").eq("source", item.source).eq("external_listing_id", item.externalListingId).abortSignal(signal).maybeSingle();
  if (existingError) throw new Error("Nie udało się sprawdzić istniejącej oferty.");
  const current = existing && typeof existing === "object" && "id" in existing && typeof existing.id === "string" ? { id: existing.id, price: typeof existing.price === "number" ? existing.price : null, contentHash: typeof existing.content_hash === "string" ? existing.content_hash : null, images: Array.isArray(existing.images) ? existing.images.filter((image: unknown): image is string => typeof image === "string") : [] } satisfies ExistingListing : null;
  const changed = needsSnapshot(current ? { price: current.price, contentHash: current.contentHash } : null, { price: item.price, contentHash: item.contentHash });
  const priceDrop = isPriceDrop(current?.price ?? null, item.price) ? 1 : 0;
  const images = resolveListingImages(current?.images ?? [], item.thumbnailUrl, item.images);
  const { data: saved, error } = await supabase.from("listings").upsert({ source: item.source, external_listing_id: item.externalListingId, original_url: item.originalUrl, normalized_url: item.normalizedUrl, title: item.title, price: item.price, area: item.area, price_per_sqm: item.pricePerSqm, rooms: item.rooms, floor: item.floor, building_type: item.buildingType, address: item.locationText, district: item.district, city: item.city, description: item.description, images, status: "active", removed_at: null, last_seen_at: matchedAt, content_hash: item.contentHash }, { onConflict: "source,external_listing_id" }).select("id").abortSignal(signal).single();
  if (error || !saved || typeof saved.id !== "string") throw new Error("Nie udało się zapisać oferty.");
  if (changed) { const { error: snapshotError } = await supabase.from("listing_snapshots").insert({ listing_id: saved.id, price: item.price, title: item.title, description: item.description, images, status: "active", raw_data: item.rawPayload }).abortSignal(signal); if (snapshotError) throw new Error("Nie udało się zapisać historii oferty."); }
  if (!createMatch) return { listingId: saved.id, listingCreated: current === null, matchCreated: false, updated: current && changed ? 1 : 0, priceDrop };
  const matchReasons = [...new Set([`${item.source}_search`, ...unknownFields.map((field) => `unknown_${field}`)])];
  const { error: insertMatchError } = await supabase.from("listing_filter_matches").insert({ listing_id: saved.id, search_filter_id: filterId, last_matched_at: matchedAt, is_current_match: true, match_reasons: matchReasons, match_score: null, match_origin: "scan", source_scan_id: sourceScanId }).abortSignal(signal);
  let matchCreated = !insertMatchError;
  if (insertMatchError) { if (insertMatchError.code !== "23505") throw new Error("Nie udało się zapisać dopasowania."); const { error: updateMatchError } = await supabase.from("listing_filter_matches").update({ last_matched_at: matchedAt, is_current_match: true, match_reasons: matchReasons, match_score: null, match_origin: "scan", source_scan_id: sourceScanId }).eq("listing_id", saved.id).eq("search_filter_id", filterId).abortSignal(signal); if (updateMatchError) throw new Error("Nie udało się odświeżyć dopasowania."); matchCreated = false; }
  return { listingId: saved.id, listingCreated: current === null, matchCreated, updated: current && changed ? 1 : 0, priceDrop };
}
