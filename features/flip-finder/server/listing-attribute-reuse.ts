import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";

type StoredAttributes = { source: string; external_listing_id: string | null; normalized_url: string | null; building_type: string | null; ownership: string | null };

/**
 * Reuses previously confirmed canonical attributes before evaluating a fresh
 * scan item. This keeps evaluation, reconciliation, and the stored listing in
 * agreement when a source omits a field on a later page/import. Queries are
 * batched per source (never one request per listing) and scoped by source plus
 * the same strong external-id / canonical-URL keys used by persistence.
 */
export async function reuseExistingListingAttributes<T extends SourceListing>(
  supabase: SupabaseClient,
  listings: readonly T[],
): Promise<T[]> {
  const missing = listings.filter((listing) => !listing.buildingType || !listing.ownership);
  if (!missing.length) return [...listings];

  const bySource = new Map<string, T[]>();
  for (const listing of missing) {
    const group = bySource.get(listing.source) ?? [];
    group.push(listing);
    bySource.set(listing.source, group);
  }

  const byIdentity = new Map<string, StoredAttributes>();
  const byUrl = new Map<string, StoredAttributes>();
  for (const [source, candidates] of bySource) {
    const ids = [...new Set(candidates.map((item) => item.externalListingId).filter(Boolean))];
    const urls = [...new Set(candidates.flatMap((item) => urlCandidates(source, item.normalizedUrl)))];
    if (ids.length) {
      const { data, error } = await supabase
        .from("listings")
        .select("source,external_listing_id,normalized_url,building_type,ownership")
        .eq("source", source)
        .in("external_listing_id", ids)
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(`LISTING_ATTRIBUTE_REUSE_FAILED: ${error.message}`);
      for (const value of rows(data)) {
        const row = toStoredAttributes(value);
        const key = row?.external_listing_id ? identityKey(source, row.external_listing_id) : null;
        // The query is ordered newest-first; retain its first row instead of
        // letting an older duplicate overwrite the latest confirmed value.
        if (row && key && !byIdentity.has(key)) byIdentity.set(key, row);
      }
    }
    if (urls.length) {
      const { data, error } = await supabase
        .from("listings")
        .select("source,external_listing_id,normalized_url,building_type,ownership")
        .eq("source", source)
        .in("normalized_url", urls)
        .order("last_seen_at", { ascending: false });
      if (error) throw new Error(`LISTING_ATTRIBUTE_REUSE_FAILED: ${error.message}`);
      for (const value of rows(data)) {
        const row = toStoredAttributes(value);
        const key = row?.normalized_url ? identityKey(source, row.normalized_url) : null;
        if (row && key && !byUrl.has(key)) byUrl.set(key, row);
      }
    }
  }

  return listings.map((listing) => {
    if (listing.buildingType && listing.ownership) return listing;
    const stored = byIdentity.get(identityKey(listing.source, listing.externalListingId))
      ?? urlCandidates(listing.source, listing.normalizedUrl)
        .map((url) => byUrl.get(identityKey(listing.source, url)))
        .find((row): row is StoredAttributes => Boolean(row));
    if (!stored) return listing;
    return {
      ...listing,
      buildingType: listing.buildingType ?? stored.building_type,
      ownership: listing.ownership ?? stored.ownership,
    };
  });
}

function urlCandidates(source: string, normalizedUrl: string): string[] {
  if (!normalizedUrl) return [];
  return source === "otodom" && /^https:\/\/otodom\.pl\/pl\/oferta\/[^/]+-id[a-z0-9]+$/iu.test(normalizedUrl)
    ? [normalizedUrl, `${normalizedUrl}.html`]
    : [normalizedUrl];
}

function identityKey(source: string, value: string): string { return `${source}\u0000${value}`; }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : []; }
function toStoredAttributes(value: Record<string, unknown>): StoredAttributes | null {
  if (typeof value.source !== "string") return null;
  return {
    source: value.source,
    external_listing_id: typeof value.external_listing_id === "string" ? value.external_listing_id : null,
    normalized_url: typeof value.normalized_url === "string" ? value.normalized_url : null,
    building_type: typeof value.building_type === "string" ? value.building_type : null,
    ownership: typeof value.ownership === "string" ? value.ownership : null,
  };
}
