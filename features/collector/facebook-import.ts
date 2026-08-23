import "server-only";

import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { getActiveSearchFiltersForSource } from "@/features/flip-finder/server/search-filters";
import { createAdminClient } from "@/lib/supabase/admin";

import { normalizeFacebookCollectorPayload, type FacebookCollectorPayload, type NormalizedFacebookImport } from "./facebook-normalization";

type ImportRow = { id: string; listingId: string | null; status: string };
export type FacebookImportResult = { status: "created" | "updated" | "duplicate"; listingId: string; matchedFilters: string[]; rejectedFilters: Array<{ filterId: string; reasons: string[] }>; calculatedPricePerSqm: number | null; missingFields: string[] };

export async function importFacebookCollectorPayload(deviceId: string, idempotencyKey: string, rawPayload: unknown): Promise<FacebookImportResult> {
  const payload = normalizeFacebookCollectorPayload(rawPayload);
  const supabase = createAdminClient();
  const existing = await findImport(supabase, deviceId, idempotencyKey);
  if (existing && existing.status !== "failed" && existing.listingId) return duplicateResult(existing.listingId, payload);
  const importRow = existing ?? await createImport(supabase, deviceId, idempotencyKey, payload);
  try {
    const saved = await upsertListing(supabase, payload);
    await upsertMetadata(supabase, saved.id, payload);
    const filters = await applyFilters(supabase, saved.id, payload);
    const result: FacebookImportResult = { status: saved.status, listingId: saved.id, matchedFilters: filters.matchedFilters, rejectedFilters: filters.rejectedFilters, calculatedPricePerSqm: payload.pricePerSqm, missingFields: missingFields(payload) };
    const { error } = await supabase.from("collector_imports").update({ listing_id: saved.id, status: "imported", error_message: null, result }).eq("id", importRow.id);
    if (error) throw new Error("Nie udało się zakończyć importu Collectora.");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nie udało się zaimportować posta Facebooka.";
    await supabase.from("collector_imports").update({ status: "failed", error_message: message }).eq("id", importRow.id);
    throw error;
  }
}

async function findImport(supabase: ReturnType<typeof createAdminClient>, deviceId: string, key: string): Promise<ImportRow | null> {
  const { data, error } = await supabase.from("collector_imports").select("id,listing_id,status").eq("device_id", deviceId).eq("idempotency_key", key).maybeSingle();
  if (error) throw new Error("Nie udało się sprawdzić duplikatu importu.");
  return isRecord(data) && typeof data.id === "string" && typeof data.status === "string" ? { id: data.id, listingId: stringOrNull(data.listing_id), status: data.status } : null;
}

async function createImport(supabase: ReturnType<typeof createAdminClient>, deviceId: string, key: string, payload: NormalizedFacebookImport): Promise<ImportRow> {
  const { data, error } = await supabase.from("collector_imports").insert({ device_id: deviceId, idempotency_key: key, source_post_url: payload.normalizedPostUrl, payload: payloadForStorage(payload), status: "received" }).select("id,listing_id,status").single();
  if (error || !isRecord(data) || typeof data.id !== "string" || typeof data.status !== "string") throw new Error("Nie udało się zapisać importu Collectora.");
  return { id: data.id, listingId: stringOrNull(data.listing_id), status: data.status };
}

async function upsertListing(supabase: ReturnType<typeof createAdminClient>, payload: NormalizedFacebookImport): Promise<{ id: string; status: "created" | "updated" }> {
  const { data: exact, error: exactError } = await supabase.from("listings").select("id").eq("source", "facebook").eq("external_listing_id", payload.externalListingId).maybeSingle();
  if (exactError) throw new Error("Nie udało się sprawdzić istniejącej oferty Facebooka.");
  if (!isRecord(exact) || typeof exact.id !== "string") {
    const { data: sameContent, error } = await supabase.from("listings").select("id").eq("source", "facebook").eq("content_hash", payload.contentHash).maybeSingle();
    if (error) throw new Error("Nie udało się sprawdzić duplikatu treści Facebooka.");
    if (isRecord(sameContent) && typeof sameContent.id === "string") return { id: sameContent.id, status: "updated" };
  }
  const title = payload.title ?? payload.content?.split(/\r?\n/, 1)[0].slice(0, 180) ?? "Oferta z Facebooka";
  const seenAt = new Date().toISOString();
  const { data, error } = await supabase.from("listings").upsert({ source: "facebook", external_listing_id: payload.externalListingId, original_url: payload.normalizedPostUrl, normalized_url: payload.normalizedPostUrl, title, price: payload.price, area: payload.area, price_per_sqm: payload.pricePerSqm, rooms: payload.rooms, address: payload.location, description: payload.content, images: payload.imageUrls, status: "active", removed_at: null, last_seen_at: seenAt, content_hash: payload.contentHash }, { onConflict: "source,external_listing_id" }).select("id").single();
  if (error || !isRecord(data) || typeof data.id !== "string") throw new Error("Nie udało się zapisać oferty Facebooka.");
  return { id: data.id, status: isRecord(exact) && typeof exact.id === "string" ? "updated" : "created" };
}

async function upsertMetadata(supabase: ReturnType<typeof createAdminClient>, listingId: string, payload: NormalizedFacebookImport): Promise<void> {
  const existing = await supabase.from("listing_source_metadata").select("metadata").eq("source", "facebook").eq("source_post_url", payload.normalizedPostUrl).maybeSingle();
  if (existing.error) throw new Error("Nie udało się odczytać workflow posta Facebooka.");
  const previous = isRecord(existing.data?.metadata) ? existing.data.metadata : {};
  const { error } = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: payload.normalizedPostUrl, group_name: payload.groupName, author_name: payload.authorName, published_at: payload.publishedAt, collected_at: payload.collectedAt, metadata: { ...previous, source: "collector", firstImportedAt: typeof previous.firstImportedAt === "string" ? previous.firstImportedAt : payload.collectedAt, imageCount: payload.imageUrls.length, workflowStatus: typeof previous.workflowStatus === "string" ? previous.workflowStatus : "new" } }, { onConflict: "source,source_post_url" });
  if (error) throw new Error("Nie udało się zapisać metadanych posta Facebooka.");
}

async function applyFilters(supabase: ReturnType<typeof createAdminClient>, listingId: string, payload: NormalizedFacebookImport): Promise<{ matchedFilters: string[]; rejectedFilters: Array<{ filterId: string; reasons: string[] }> }> {
  const matchedFilters: string[] = []; const rejectedFilters: Array<{ filterId: string; reasons: string[] }> = [];
  for (const filter of await getActiveSearchFiltersForSource("facebook")) {
    const decision = evaluateListingAgainstFilter({ price: payload.price, area: payload.area, pricePerSqm: payload.pricePerSqm, rooms: payload.rooms, floor: null, city: null, district: null, title: payload.title ?? payload.content, locationText: payload.location, buildingType: null }, filter);
    if (!decision.matches) { rejectedFilters.push({ filterId: filter.id, reasons: decision.reasons }); continue; }
    const { error } = await supabase.from("listing_filter_matches").insert({ listing_id: listingId, search_filter_id: filter.id, last_matched_at: new Date().toISOString(), is_current_match: true, match_score: null, match_reasons: ["collector_import", ...decision.unknownFields.map((field) => `unknown_${field}`)], match_origin: "collector_import", source_scan_id: null });
    if (error && error.code !== "23505") throw new Error("Nie udało się zapisać dopasowania Collectora.");
    if (!error) matchedFilters.push(filter.id);
  }
  return { matchedFilters, rejectedFilters };
}

function duplicateResult(listingId: string, payload: NormalizedFacebookImport): FacebookImportResult { return { status: "duplicate", listingId, matchedFilters: [], rejectedFilters: [], calculatedPricePerSqm: payload.pricePerSqm, missingFields: missingFields(payload) }; }
function missingFields(payload: NormalizedFacebookImport): string[] { return [["title", payload.title], ["price", payload.price], ["area", payload.area], ["rooms", payload.rooms], ["location", payload.location]].filter((entry): entry is [string, null] => entry[1] === null).map(([field]) => field); }
function payloadForStorage(payload: NormalizedFacebookImport): Record<string, unknown> { return { sourcePostUrl: payload.normalizedPostUrl, title: payload.title, groupName: payload.groupName, authorName: payload.authorName, publishedAt: payload.publishedAt, content: payload.content, price: payload.price, area: payload.area, rooms: payload.rooms, location: payload.location, imageUrls: payload.imageUrls, collectedAt: payload.collectedAt }; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export type { FacebookCollectorPayload };
