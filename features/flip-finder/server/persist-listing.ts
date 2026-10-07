import "server-only";

import { resolveListingImages } from "@/features/flip-finder/listing-images";
import { isPriceDrop, needsSnapshot } from "@/features/flip-finder/otodom-search";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { PropertyListing } from "@/features/properties/types/property";
import type { SupabaseClient } from "@supabase/supabase-js";
import { staleListingFilterMatchKey, staleListingFilterMatchValues } from "./match-state";
import type { DecisionBucket } from "../decision-model";
import { syncResaleCompFromListing } from "@/features/market-intelligence/resale-comps-store";
import { reconcileCanonicalListingDecision } from "./canonical-reconciliation";
import { analyzeListingWithAiIfNeeded } from "./listing-ai-analysis";
import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";

type ExistingListing = Pick<PropertyListing, "id" | "price" | "contentHash" | "images"> & {
  manualDecision?: "ACCEPTED" | "REJECTED" | null;
  lifecycleStatus?: "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED" | null;
  archivedAt?: string | null;
  buildingType?: string | null;
  ownership?: string | null;
};

export async function deactivateListingFilterMatch(supabase: SupabaseClient, listingId: string, filterId: string, signal?: AbortSignal): Promise<void> {
  const key = staleListingFilterMatchKey(listingId, filterId);
  let query = supabase.from("listing_filter_matches").update(staleListingFilterMatchValues()).eq("listing_id", key.listingId).eq("search_filter_id", key.searchFilterId).eq("is_current_match", true);
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  if (error) throw new Error("Nie udało się wygasić nieaktualnego dopasowania.");
}

export async function persistListing(supabase: SupabaseClient, filterId: string, item: SourceListing, createMatch: boolean, unknownFields: string[], sourceScanId: string, matchedAt: string, signal: AbortSignal, decision?: { bucket?: DecisionBucket; reasons?: string[]; unknownFields?: string[] }): Promise<{ listingId: string; listingCreated: boolean; matchCreated: boolean; updated: number; priceDrop: number }> {
  const bucket = decision?.bucket ?? (createMatch ? "MATCHED" : unknownFields.length ? "REVIEW" : "REJECTED");
  const reviewFields = decision?.unknownFields ?? unknownFields;
  const reviewReasons = decision?.reasons ?? [];
  // `manual_decision` was added with the review-lifecycle migration. Keep the
  // lookup compatible while that migration is being rolled out: the value is
  // not needed to decide whether this scan should update/create the listing.
  let existingResult = await supabase.from("listings").select("id,external_listing_id,price,content_hash,images,manual_decision,lifecycle_status,archived_at,building_type,ownership").eq("source", item.source).eq("external_listing_id", item.externalListingId).abortSignal(signal).maybeSingle();
  if (isMissingReviewLifecycleColumn(existingResult.error)) {
    existingResult = await supabase.from("listings").select("id,external_listing_id,price,content_hash,images").eq("source", item.source).eq("external_listing_id", item.externalListingId).abortSignal(signal).maybeSingle();
  }
  // A portal can rotate an external id while keeping the canonical URL. Reuse
  // the newest source-local URL match instead of creating a second listing.
  if (!existingResult.error && !existingResult.data && item.normalizedUrl) {
    for (const normalizedUrl of normalizedUrlCandidates(item.source, item.normalizedUrl)) {
      const byUrl = await supabase.from("listings").select("id,external_listing_id,price,content_hash,images,manual_decision,lifecycle_status,archived_at,building_type,ownership").eq("source", item.source).eq("normalized_url", normalizedUrl).order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
      if (byUrl.data) {
        existingResult = byUrl;
        break;
      }
      if (byUrl.error) {
        existingResult = byUrl;
        break;
      }
    }
  }
  const existingError = existingResult.error;
  const existing = existingResult.data;
  if (existingError) throw new Error("Nie udało się sprawdzić istniejącej oferty.");
  const current = existing && typeof existing === "object" && "id" in existing && typeof existing.id === "string" ? { id: existing.id, price: typeof existing.price === "number" ? existing.price : null, contentHash: typeof existing.content_hash === "string" ? existing.content_hash : null, images: Array.isArray(existing.images) ? existing.images.filter((image: unknown): image is string => typeof image === "string") : [], buildingType: typeof existing.building_type === "string" ? existing.building_type : null, ownership: typeof existing.ownership === "string" ? existing.ownership : null } satisfies ExistingListing : null;
  const manualRejected = existing && typeof existing === "object" && existing.manual_decision === "REJECTED";
  const archivedAt = existing && typeof existing === "object" && typeof existing.archived_at === "string" ? existing.archived_at : null;
  const canonicalExternalListingId = existing && typeof existing === "object" && typeof existing.external_listing_id === "string" ? existing.external_listing_id : item.externalListingId;
  const changed = needsSnapshot(current ? { price: current.price, contentHash: current.contentHash } : null, { price: item.price, contentHash: item.contentHash });
  const priceDrop = isPriceDrop(current?.price ?? null, item.price) ? 1 : 0;
  const images = resolveListingImages(current?.images ?? [], item.thumbnailUrl, item.images);
  // A re-scan that genuinely has no fresh signal for buildingType/ownership
  // (the adapter returns null this time -- a different page snippet, a
  // shorter description, etc.) must never erase a value a PREVIOUS scan
  // already confirmed. Only a real, non-null value from this scan ever
  // overwrites what is already stored; it is never cleared back to unknown.
  const buildingType = item.buildingType ?? current?.buildingType ?? null;
  const ownership = item.ownership ?? current?.ownership ?? null;
  const listingValues = { source: item.source, external_listing_id: item.externalListingId, original_url: item.originalUrl, normalized_url: item.normalizedUrl, title: item.title, price: item.price, area: item.area, price_per_sqm: item.pricePerSqm, rooms: item.rooms, floor: item.floor, building_type: buildingType, ownership, year_built: item.yearBuilt ?? null, address: item.locationText, district: item.district, city: item.city, description: item.description, images, status: "active", removed_at: null, last_seen_at: matchedAt, lifecycle_status: bucket === "MATCHED" ? "ACTIVE" : bucket, review_reason: bucket === "REVIEW" ? (reviewReasons.length ? reviewReasons.join(", ") : "Wymaga ręcznej oceny") : null, missing_fields: bucket === "REVIEW" ? reviewFields : [], archived_at: null, content_hash: item.contentHash };
  listingValues.external_listing_id = canonicalExternalListingId;
  if (manualRejected) {
    listingValues.lifecycle_status = "REJECTED";
    listingValues.review_reason = null;
    listingValues.missing_fields = [];
    (listingValues as { archived_at: string | null }).archived_at = archivedAt ?? matchedAt;
  }
  let { data: saved, error } = await supabase.from("listings").upsert(listingValues, { onConflict: "source,external_listing_id" }).select("id").abortSignal(signal).single();
  // year_built's own migration (draft, not yet applied -- see
  // supabase/migrations) may not exist on the real table yet. Probed and
  // dropped on its own, independent of the review-lifecycle fallback below,
  // so a scan is never broken by one missing optional column it doesn't
  // need: today's deploys keep working exactly as before, and the moment a
  // human applies that migration, this starts persisting with no further
  // code change.
  if (isMissingYearBuiltColumn(error)) {
    const { year_built: _yearBuilt, ...listingValuesWithoutYearBuilt } = listingValues;
    ({ data: saved, error } = await supabase.from("listings").upsert(listingValuesWithoutYearBuilt, { onConflict: "source,external_listing_id" }).select("id").abortSignal(signal).single());
  }
  if (isMissingReviewLifecycleColumn(error)) {
    const legacyValues = { source: item.source, external_listing_id: item.externalListingId, original_url: item.originalUrl, normalized_url: item.normalizedUrl, title: item.title, price: item.price, area: item.area, price_per_sqm: item.pricePerSqm, rooms: item.rooms, floor: item.floor, building_type: buildingType, ownership, address: item.locationText, district: item.district, city: item.city, description: item.description, images, status: "active", removed_at: null, last_seen_at: matchedAt, content_hash: item.contentHash };
    legacyValues.external_listing_id = canonicalExternalListingId;
    ({ data: saved, error } = await supabase.from("listings").upsert(legacyValues, { onConflict: "source,external_listing_id" }).select("id").abortSignal(signal).single());
  }
  if (error || !saved || typeof saved.id !== "string") throw new Error("Nie udało się zapisać oferty.");
  void syncResaleCompFromListing(supabase, item, saved.id, matchedAt).catch((reason) => {
    console.warn("RESALE_COMP_SYNC_DEFERRED", {
      source: item.source,
      externalListingId: item.externalListingId,
      error: reason instanceof Error ? reason.message : "unknown",
    });
  });
  // Advisory-only AI observations, cached per listing -- only attempted when
  // this listing is brand new or its description/price actually changed
  // (the exact same `current`/`changed` this function already computes for
  // snapshot history below), never on an unchanged re-scan and never from a
  // render/read path. Deferred via runAfterResponse -- same as the scan
  // route's own background continuation -- rather than a bare `void
  // promise`: on Vercel, a plain detached promise can be frozen mid-flight
  // the moment this request's response is sent, silently losing the call
  // (and any partial cost already incurred) before it ever writes its
  // result. runAfterResponse prefers next/server's after() (backed by the
  // platform's waitUntil) and only falls back to the previous bare
  // fire-and-forget behavior outside a request scope (e.g. the unit tests
  // that call persistListing directly, with no Next.js request active).
  if (current === null || changed) {
    runAfterResponse(() =>
      analyzeListingWithAiIfNeeded(supabase, saved.id, { title: item.title, city: item.city, description: item.description, images }).catch((reason) => {
        console.warn("LISTING_AI_ANALYSIS_DEFERRED", {
          source: item.source,
          externalListingId: item.externalListingId,
          error: reason instanceof Error ? reason.message : "unknown",
        });
      }),
    );
  }
  if (changed) { const { error: snapshotError } = await supabase.from("listing_snapshots").insert({ listing_id: saved.id, price: item.price, title: item.title, description: item.description, images, status: "active", raw_data: item.rawPayload }).abortSignal(signal); if (snapshotError) throw new Error("Nie udało się zapisać historii oferty."); }
  const persistedDecision = decision ? {
    bucket: decision.bucket ?? bucket,
    reasons: decision.reasons ?? reviewReasons,
    missingFields: decision.unknownFields ?? reviewFields,
    hardRejectReasons: (decision.bucket ?? bucket) === "REJECTED" ? (decision.reasons ?? reviewReasons) : [],
  } : {
    bucket,
    reasons: manualRejected ? ["manual_rejected"] : reviewReasons,
    missingFields: reviewFields,
    hardRejectReasons: bucket === "REJECTED" ? reviewReasons : [],
  };
  const reconciliation = await reconcileCanonicalListingDecision({
    supabase,
    listingId: saved.id,
    filterId,
    decision: manualRejected ? { bucket: "REJECTED", reasons: ["manual_rejected"], missingFields: [], hardRejectReasons: ["manual_rejected"] } : persistedDecision,
    matchOrigin: "scan",
    sourceScanId,
    matchedAt,
    signal,
  });
  const matchCreated = reconciliation.isCurrentMatch && !current;
  return { listingId: saved.id, listingCreated: current === null, matchCreated, updated: current && changed ? 1 : 0, priceDrop };
}

function isMissingReviewLifecycleColumn(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42703" || code === "PGRST204") && /lifecycle_status|review_reason|missing_fields|archived_at|manual_decision/.test(message);
}

function isMissingYearBuiltColumn(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42703" || code === "PGRST204") && /year_built/.test(message);
}

function normalizedUrlCandidates(source: string, normalizedUrl: string): string[] {
  const candidates = [normalizedUrl];
  if (source === "otodom" && /^https:\/\/otodom\.pl\/pl\/oferta\/[^/]+-id[a-z0-9]+$/i.test(normalizedUrl)) {
    // Rows written before the canonical `.html` normalization may still have
    // the legacy suffix in normalized_url. Read it during ingest so the next
    // scan repairs that row in place instead of creating a duplicate.
    candidates.push(`${normalizedUrl}.html`);
  }
  return candidates;
}
