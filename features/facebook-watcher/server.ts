import "server-only";

import { createHash } from "node:crypto";
import { calculateFlipScore } from "@/features/flip-score/calculate-flip-score";
import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { calculateContentHash } from "@/features/flip-finder/otodom-search";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { getActiveSearchFiltersForSource } from "@/features/flip-finder/server/search-filters";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { SearchFilter } from "@/features/flip-finder";
import { extractFacebookListing, isUsableFacebookProperty } from "./extract-facebook-listing";
import type { FacebookProperty } from "./types";
import { manualFacebookAdapter } from "./facebook-source-adapter";
import { createFacebookWatcherAdminClient } from "./supabase-admin";
import { isLikelySameFacebookProperty } from "./deduplicate-facebook-listing";
import { mirrorFacebookImages } from "./server/mirror-facebook-images";
import { FACEBOOK_WORKFLOW_STATUSES, type FacebookListingInput, type FacebookWatcherListing, type FacebookWorkflowStatus } from "./types";
import { recordFacebookGroupImport } from "@/features/facebook-groups/server";

type Row = Record<string, unknown>;

export type FacebookAutomatedImportContext = {
  filter: SearchFilter;
  sourceScanId: string;
  groupId: string;
  groupName: string;
  groupUrl: string;
  postId: string | null;
  checkedAt: string;
};

export type FacebookImportResult = {
  status: "created" | "updated" | "skipped";
  listingId: string | null;
  extracted: FacebookProperty;
  opportunityScore: number;
  listingCreated: boolean;
  listingUpdated: boolean;
  matched: boolean;
  matchCreated: boolean;
  imagesMirrored: number;
  priceDrops: number;
  warnings: string[];
};

export async function importFacebookWatcher(input: FacebookListingInput, context?: FacebookAutomatedImportContext): Promise<FacebookImportResult> {
  const normalized = await manualFacebookAdapter.importManual(input);
  const extractedBase = await extractFacebookListing(normalized);
  const extracted = { ...extractedBase, ...normalized.overrides, originalUrl: extractedBase.originalUrl, images: extractedBase.images, flags: normalized.analysisFlags ?? extractedBase.flags, confidence: typeof normalized.analysisConfidence === "number" ? Math.max(0, Math.min(1, normalized.analysisConfidence)) : extractedBase.confidence };
  if (context && !isUsableFacebookProperty(extracted, normalized.postText)) {
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [] };
  }
  const hash = createHash("sha256").update([normalized.postText, extracted.price, extracted.area, extracted.neighborhood].join("|")).digest("hex");
  const sourceUrl = extracted.originalUrl ?? (context ? facebookPostUrl(context.groupUrl, context.postId) : `manual:${hash}`);
  const externalId = context?.postId ?? extracted.originalUrl?.match(/(?:posts|videos)\/(\d+)/)?.[1] ?? hash.slice(0, 32);
  const supabase = createFacebookWatcherAdminClient();
  const existing = await findExisting(supabase, extracted, sourceUrl, externalId, hash);
  const now = context?.checkedAt ?? new Date().toISOString();
  if (context) return importAutomatedFacebook({ supabase, normalized, extracted, context, sourceUrl, externalId, existing, now });
  let listingId = existing?.id;
  const status: "created" | "updated" = existing ? "updated" : "created";
  const crossSourceMatch = Boolean(existing && existing.source !== "facebook");
  const existingListingState = listingId ? await readListingState(supabase, listingId) : { images: [], firstSeenAt: null };
  const existingImages = existingListingState.images;
  const pricePerSqm = extracted.price && extracted.area ? extracted.price / extracted.area : null;
  const score = calculateFlipScore({ price: extracted.price, pricePerSqm, averagePricePerSqm: null, rooms: extracted.rooms, area: extracted.area, marketType: extracted.marketType, title: extracted.title, description: extracted.description }).score;

  if (!listingId) {
    const storedUrl = extracted.originalUrl ?? `https://www.facebook.com/flip-manager/manual/${hash}`;
    const { data, error } = await supabase.from("listings").insert({ source: "facebook", external_listing_id: externalId, original_url: storedUrl, normalized_url: extracted.originalUrl, title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), address: extracted.street, district: extracted.district, city: extracted.city, description: extracted.description, images: [], status: "active", content_hash: hash, flip_score: score, last_seen_at: now }).select("id").single();
    if (error || !data?.id) throw new Error(`Nie udało się zapisać oferty Facebooka: ${error?.message ?? "brak ID"}`);
    listingId = String(data.id);
  } else if (!crossSourceMatch) {
    const { error } = await supabase.from("listings").update({ title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rooms: extracted.rooms, district: extracted.district, city: extracted.city, description: extracted.description, flip_score: score, last_seen_at: now }).eq("id", listingId);
    if (error) throw new Error(`Nie udało się zaktualizować oferty: ${error.message}`);
  }
  const imageMirror = await mirrorFacebookImages({ listingId, imageUrls: extracted.images, existingImages });
  extracted.images = imageMirror.images;
  const { error: imagesError } = await supabase.from("listings").update({ images: imageMirror.images }).eq("id", listingId);
  if (imagesError) throw new Error(`Nie udało się zapisać stabilnych zdjęć Facebooka: ${imagesError.message}`);
  const previousMetadata = await readSourceMetadata(supabase, sourceUrl);
  const { error: metadataError } = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: normalized.groupName ?? null, author_name: normalized.authorName ?? null, published_at: normalized.publishedAt ?? null, collected_at: now, metadata: { ...previousMetadata, source: "facebook_watcher", firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingListingState.firstSeenAt ?? now, neighborhood: extracted.neighborhood, confidence: extracted.confidence, flags: extracted.flags, sellerType: extracted.sellerType, condition: extracted.condition, opportunityScore: score, crossSourceMatch, imageMirror: imageMirror.stats, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadataError) throw new Error(`Nie udało się zapisać metadanych Facebooka: ${metadataError.message}`);
  await applyFilters(supabase, listingId, extracted, pricePerSqm);
  await recordFacebookGroupImport(normalized.groupName, status === "created", score >= 85 || extracted.sellerType === "private" && extracted.condition === "renovation");
  return { status, listingId, extracted, opportunityScore: score, listingCreated: status === "created", listingUpdated: status === "updated", matched: false, matchCreated: false, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops: 0, warnings: imageMirror.warnings };
}

async function importAutomatedFacebook(input: {
  supabase: ReturnType<typeof createFacebookWatcherAdminClient>;
  normalized: FacebookListingInput;
  extracted: FacebookProperty;
  context: FacebookAutomatedImportContext;
  sourceUrl: string;
  externalId: string;
  existing: { id: string; source: string } | null;
  now: string;
}): Promise<FacebookImportResult> {
  const { supabase, normalized, extracted, context, sourceUrl, externalId, existing, now } = input;
  const crossSourceMatch = Boolean(existing && existing.source !== "facebook");
  const existingState = existing ? await readListingState(supabase, existing.id) : { images: [], firstSeenAt: null };
  const imageMirror = await mirrorFacebookImages({ listingId: existing?.id ?? externalId, imageUrls: extracted.images, existingImages: existingState.images });
  extracted.images = imageMirror.images;
  const pricePerSqm = extracted.price && extracted.area ? extracted.price / extracted.area : null;
  const score = calculateFlipScore({ price: extracted.price, pricePerSqm, averagePricePerSqm: null, rooms: extracted.rooms, area: extracted.area, marketType: extracted.marketType, title: extracted.title, description: extracted.description }).score;
  const locationText = [extracted.street, extracted.neighborhood, extracted.district, extracted.city].filter(Boolean).join(", ") || null;
  const decision = evaluateListingAgainstFilter({ price: extracted.price, area: extracted.area, pricePerSqm, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), city: extracted.city, district: extracted.district, title: extracted.title, locationText, buildingType: null, sellerType: extracted.sellerType, marketType: extracted.marketType, ownership: null }, context.filter);
  let listingId: string;
  let listingCreated = false;
  let listingUpdated = false;
  let matchCreated = false;
  let priceDrops = 0;

  if (crossSourceMatch && existing) {
    listingId = existing.id;
    const imagesUpdate = await supabase.from("listings").update({ images: imageMirror.images }).eq("id", listingId);
    if (imagesUpdate.error) throw new Error(`FACEBOOK_IMAGE_PERSIST_FAILED: ${imagesUpdate.error.message}`);
    matchCreated = decision.matches ? await upsertAutomatedMatch(supabase, listingId, context, decision.unknownFields, now) : false;
  } else {
    const rawPayload = { source: "facebook", postId: context.postId, groupId: context.groupId, groupName: context.groupName, publishedAt: normalized.publishedAt ?? null, flags: extracted.flags };
    const contentHash = calculateContentHash({ title: extracted.title, description: extracted.description, price: extracted.price, area: extracted.area, rooms: extracted.rooms, floor: extracted.floor, locationText, images: imageMirror.images });
    const listing: SourceListing = { source: "facebook", externalListingId: externalId, originalUrl: sourceUrl, normalizedUrl: sourceUrl, title: extracted.title, price: extracted.price, area: extracted.area, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), pricePerSqm, city: extracted.city, district: extracted.district, locationText, images: imageMirror.images, thumbnailUrl: imageMirror.images[0] ?? null, buildingType: null, description: extracted.description, rawPayload, contentHash };
    const saved = await persistListing(supabase, context.filter.id, listing, decision.matches, decision.unknownFields, context.sourceScanId, now, AbortSignal.timeout(75_000));
    listingId = saved.listingId;
    listingCreated = saved.listingCreated;
    listingUpdated = saved.updated > 0;
    matchCreated = saved.matchCreated;
    priceDrops = saved.priceDrop;
    const scoreUpdate = await supabase.from("listings").update({ flip_score: score }).eq("id", listingId);
    if (scoreUpdate.error) throw new Error(`FACEBOOK_SCORE_PERSIST_FAILED: ${scoreUpdate.error.message}`);
  }

  const previousMetadata = await readSourceMetadata(supabase, sourceUrl);
  const metadata = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: context.groupName, author_name: null, published_at: normalized.publishedAt ?? null, collected_at: now, metadata: { ...previousMetadata, source: "facebook_worker", groupId: context.groupId, groupName: context.groupName, postId: context.postId, importedAt: str(previousMetadata.importedAt) ?? now, checkedAt: now, firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingState.firstSeenAt ?? now, neighborhood: extracted.neighborhood, confidence: extracted.confidence, flags: extracted.flags, sellerType: extracted.sellerType, condition: extracted.condition, opportunityScore: score, crossSourceMatch, imageMirror: imageMirror.stats, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadata.error) throw new Error(`FACEBOOK_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  await recordFacebookGroupImport(context.groupName, listingCreated, score >= 85 || extracted.sellerType === "private" && extracted.condition === "renovation");
  return { status: listingCreated ? "created" : "updated", listingId, extracted, opportunityScore: score, listingCreated, listingUpdated, matched: decision.matches, matchCreated, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops, warnings: imageMirror.warnings };
}

async function upsertAutomatedMatch(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, listingId: string, context: FacebookAutomatedImportContext, unknownFields: string[], matchedAt: string): Promise<boolean> {
  const values = { listing_id: listingId, search_filter_id: context.filter.id, last_matched_at: matchedAt, is_current_match: true, match_reasons: ["facebook_search", ...unknownFields.map((field) => `unknown_${field}`)], match_score: null, match_origin: "scan", source_scan_id: context.sourceScanId };
  const inserted = await supabase.from("listing_filter_matches").insert(values);
  if (!inserted.error) return true;
  if (inserted.error.code !== "23505") throw new Error(`FACEBOOK_MATCH_PERSIST_FAILED: ${inserted.error.message}`);
  const updated = await supabase.from("listing_filter_matches").update(values).eq("listing_id", listingId).eq("search_filter_id", context.filter.id);
  if (updated.error) throw new Error(`FACEBOOK_MATCH_UPDATE_FAILED: ${updated.error.message}`);
  return false;
}

function facebookPostUrl(groupUrl: string, postId: string | null): string {
  if (!postId) throw new Error("FACEBOOK_POST_ID_REQUIRED");
  const base = new URL(groupUrl); base.pathname = `${base.pathname.replace(/\/$/, "")}/posts/${encodeURIComponent(postId)}/`; base.search = ""; base.hash = "";
  return base.toString();
}

async function readSourceMetadata(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, sourceUrl: string): Promise<Row> {
  const { data, error } = await supabase.from("listing_source_metadata").select("metadata").eq("source", "facebook").eq("source_post_url", sourceUrl).maybeSingle();
  if (error) throw new Error(`Nie udało się odczytać metadanych workflow Facebooka: ${error.message}`);
  return data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata as Row : {};
}

async function readListingState(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, listingId: string): Promise<{ images: string[]; firstSeenAt: string | null }> {
  const { data, error } = await supabase.from("listings").select("images,first_seen_at").eq("id", listingId).maybeSingle();
  if (error) throw new Error(`Nie udało się odczytać istniejących zdjęć oferty: ${error.message}`);
  return { images: Array.isArray(data?.images) ? data.images.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [], firstSeenAt: str(data?.first_seen_at) };
}

async function findExisting(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, item: FacebookProperty, sourceUrl: string, externalId: string, hash: string): Promise<{id:string;source:string}|null> {
  const metadata = await supabase.from("listing_source_metadata").select("listing_id").eq("source", "facebook").eq("source_post_url", sourceUrl).maybeSingle();
  if (metadata.data?.listing_id) return { id: String(metadata.data.listing_id), source: "facebook" };
  const exact = await supabase.from("listings").select("id,source").or(`normalized_url.eq.${sourceUrl},and(source.eq.facebook,external_listing_id.eq.${externalId}),content_hash.eq.${hash}`).limit(1).maybeSingle();
  if (exact.data?.id) return { id: String(exact.data.id), source: String(exact.data.source) };
  const { data } = await supabase.from("listings").select("id,source,title,price,area,district,address").eq("status", "active").limit(500);
  for (const row of (data ?? []) as Row[]) {
    if (isLikelySameFacebookProperty(item, { price: num(row.price), area: num(row.area), district: str(row.district), address: str(row.address) })) return { id: String(row.id), source: String(row.source) };
  }
  return null;
}

async function applyFilters(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, listingId: string, item: FacebookProperty, pricePerSqm: number | null) {
  for (const filter of await getActiveSearchFiltersForSource("facebook")) {
    const decision = evaluateListingAgainstFilter({ price: item.price, area: item.area, pricePerSqm, rooms: item.rooms, floor: item.floor === null ? null : String(item.floor), city: item.city, district: item.district, title: item.title, locationText: [item.neighborhood,item.district,item.city].filter(Boolean).join(", "), buildingType: null, sellerType: item.sellerType, marketType: item.marketType, ownership: null }, filter);
    if (!decision.matches) continue;
    await supabase.from("listing_filter_matches").upsert({ listing_id: listingId, search_filter_id: filter.id, last_matched_at: new Date().toISOString(), is_current_match: true, match_score: null, match_reasons: ["collector_import", ...item.flags], match_origin: "collector_import", source_scan_id: null }, { onConflict: "listing_id,search_filter_id" });
  }
}

export async function listFacebookWatcher(): Promise<FacebookWatcherListing[]> {
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.from("listing_source_metadata").select("source_post_url,group_name,published_at,collected_at,metadata,listings(id,title,price,price_per_sqm,area,rooms,floor,district,city,address,description,original_url,images,status,source,flip_score,estimated_profit,first_seen_at,last_seen_at,created_at,building_type,ownership)").eq("source", "facebook").order("collected_at", { ascending: false }).limit(500);
  if (error) throw new Error(`Nie udało się pobrać ofert Facebooka: ${error.message}`);
  const seenListingIds = new Set<string>();
  return ((data ?? []) as unknown as Row[]).flatMap((row) => {
    const listing = (Array.isArray(row.listings) ? row.listings[0] : row.listings) as Row | undefined; if (!listing) return [];
    const listingId = String(listing.id); if (seenListingIds.has(listingId)) return []; seenListingIds.add(listingId);
    const meta = (row.metadata ?? {}) as Row;
    const flags = Array.isArray(meta.flags) ? meta.flags.filter((x):x is string=>typeof x==="string") : [];
    const importedAt = str(meta.firstImportedAt) ?? str(row.collected_at) ?? str(listing.created_at) ?? new Date(0).toISOString();
    const publishedAt = str(row.published_at);
    const sellerType = facebookSellerType(meta.sellerType, flags);
    const condition = facebookCondition(meta.condition, flags);
    const score = num(meta.opportunityScore) ?? num(listing.flip_score) ?? 0;
    const flipScore = num(listing.flip_score) ?? 0;
    const readAt = str(meta.readAt);
    const source = String(listing.source);
    const facebookUrl = str(row.source_post_url);
    const sourceUrl = str(listing.original_url);
    return [{ listingId, title: String(listing.title ?? "Oferta z Facebooka"), city: str(listing.city), district: str(listing.district), neighborhood: str(meta.neighborhood), street: str(listing.address), price: num(listing.price), pricePerSqm: num(listing.price_per_sqm), area: num(listing.area), rooms: num(listing.rooms), floor: num(listing.floor), totalFloors: null, marketType: null, sellerType, condition, description: str(listing.description), originalUrl: facebookUrl?.startsWith("http") ? facebookUrl : null, images: Array.isArray(listing.images) ? listing.images.filter((x):x is string=>typeof x==="string") : [], confidence: num(meta.confidence) ?? 0, flags, status: String(listing.status), groupName: str(row.group_name), workflowStatus: workflowStatus(meta.workflowStatus), readAt, importedAt, publishedAt, opportunityScore: score, flipScore, potentialProfit: num(listing.estimated_profit), isNew: !readAt && Date.now() - Date.parse(importedAt) <= 86_400_000, highPriority: score >= 85 || flipScore >= 85 || sellerType === "private" && condition === "renovation", crossSourceMatch: meta.crossSourceMatch === true, crossSourceLinks: meta.crossSourceMatch === true && source !== "facebook" && sourceUrl ? [{ source, url: sourceUrl }] : [], source }];
  });
}
export async function updateFacebookWatcherWorkflow(listingId: string, input: { status?: FacebookWorkflowStatus; markRead?: boolean; crmPropertyId?: string }): Promise<void> {
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.from("listing_source_metadata").select("id,metadata").eq("source", "facebook").eq("listing_id", listingId);
  if (error) throw new Error(`Nie udało się odczytać workflow oferty: ${error.message}`);
  if (!data?.length) throw new Error("Nie znaleziono oferty Facebooka.");
  for (const row of data) {
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Row : {};
    const next = { ...metadata, ...(input.status ? { workflowStatus: input.status } : {}), ...(input.markRead ? { readAt: new Date().toISOString() } : {}), ...(input.crmPropertyId ? { crmPropertyId: input.crmPropertyId } : {}) };
    const { error: updateError } = await supabase.from("listing_source_metadata").update({ metadata: next }).eq("id", row.id);
    if (updateError) throw new Error(`Nie udało się zaktualizować workflow oferty: ${updateError.message}`);
  }
}
function workflowStatus(value: unknown): FacebookWorkflowStatus { return FACEBOOK_WORKFLOW_STATUSES.includes(value as FacebookWorkflowStatus) ? value as FacebookWorkflowStatus : "new"; }
function facebookSellerType(value: unknown, flags: string[]): FacebookWatcherListing["sellerType"] { if (value === "private" || value === "agency") return value; return flags.some((flag)=>/bezpośred|właściciel/i.test(flag)) ? "private" : null; }
function facebookCondition(value: unknown, flags: string[]): FacebookWatcherListing["condition"] { if (value === "renovation" || value === "ready") return value; return flags.some((flag)=>/remont/i.test(flag)) ? "renovation" : null; }
const str=(v:unknown)=>typeof v==="string"?v:null; const num=(v:unknown)=>typeof v==="number"?v:typeof v==="string"&&v!==""?Number(v):null;
