import "server-only";

import { createHash } from "node:crypto";
import { calculateFlipScore } from "@/features/flip-score/calculate-flip-score";
import { evaluateListingAgainstFilter } from "@/features/flip-finder/filter-evaluation";
import { decisionBucket } from "@/features/flip-finder/decision-model";
import { calculateContentHash } from "@/features/flip-finder/otodom-search";
import { deactivateListingFilterMatch, persistListing } from "@/features/flip-finder/server/persist-listing";
import { getActiveSearchFiltersForSource } from "@/features/flip-finder/server/search-filters";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { SearchFilter } from "@/features/flip-finder";
import { classifyFacebookProperty, extractFacebookListing } from "./extract-facebook-listing";
import type { FacebookProperty } from "./types";
import { manualFacebookAdapter } from "./facebook-source-adapter";
import { createFacebookWatcherAdminClient } from "./supabase-admin";
import { isLikelySameFacebookProperty } from "./deduplicate-facebook-listing";
import { mirrorFacebookImages } from "./server/mirror-facebook-images";
import { FACEBOOK_WORKFLOW_STATUSES, type FacebookListingInput, type FacebookWatcherListing, type FacebookWorkflowStatus } from "./types";
import { recordFacebookGroupImport } from "@/features/facebook-groups/server";
import { facebookNoMatchWarnings, mergeFacebookPropertyByConfidence, parseFacebookFieldConfidence } from "./facebook-data-quality";
import { resolveFacebookListingIntent } from "./facebook-intent";
import { reconcileFacebookLocation } from "./facebook-location-quality";
import { exactBoundPropertyImages, facebookImagePersistenceDiagnostics, facebookImageProvenanceDiagnostics, facebookMediaBindingSummary, hasApprovedFacebookImageProvenance, preserveFacebookPublishedAt } from "./facebook-media-binding";
import { evaluateFacebookApartmentSafety } from "./facebook-apartment-safety";
import { resolveFacebookBuildingEvidence, type FacebookBuildingEvidence } from "./facebook-building-evidence";
import { syncResaleCompFromListing } from "@/features/market-intelligence/resale-comps-store";

type Row = Record<string, unknown>;

export type FacebookAutomatedImportContext = {
  filter: SearchFilter;
  sourceScanId: string;
  groupId: string;
  groupName: string;
  groupUrl: string;
  postId: string | null;
  checkedAt: string;
  preserveExistingImagesOnEmptyInput?: boolean;
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
  persistenceDiagnostics?: {
    postId: string | null;
    creationTime: string | null;
    timestampSource: "POST_PAGE_METADATA" | "POST_PAGE" | "UNKNOWN";
    publishedAtCandidate: string | null;
    publishedAtPersistAttempted: boolean;
    publishedAtPersisted: boolean;
    exactBoundCandidates: number;
    relevanceAccepted: number;
    relevanceRejected: number;
    mirrorAttempted: number;
    mirroredCount: number;
    persistedNewImageCount: number;
    finalListingImageCount: number;
    persistedImageCount: number;
    imageReasonCode: string;
    reasonCodes: string[];
    imageProvenance: import("../facebook-worker/post-flow").FacebookImageProvenanceDiagnostic[];
  };
  notProperty?: {
    realEstateLanguage: boolean;
    structuredFieldCount: number;
    detectedFields: string[];
    classification?: "not_a_property" | "non_sale_intent";
    reasonCode?: import("../facebook-worker/types").FacebookSkipReasonCode;
  };
};

export async function importFacebookWatcher(input: FacebookListingInput, context?: FacebookAutomatedImportContext): Promise<FacebookImportResult> {
  const normalized = await manualFacebookAdapter.importManual(input);
  const intent = resolveFacebookListingIntent(normalized.postText, normalized.listingIntent, normalized.intentConfidence);
  if (context && intent.intent !== "SELL_PROPERTY") {
    const extracted = skippedFacebookProperty(normalized, intent.intent, intent.confidence, intent.intentSource);
    const realEstateLanguage = intent.intent === "BUY_PROPERTY" || intent.intent === "RENT_OFFER" || intent.intent === "RENT_WANTED";
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], notProperty: { realEstateLanguage, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent", reasonCode: intent.reasonCode ?? "FACEBOOK_INTENT_UNKNOWN" } };
  }
  const extractedBase = await extractFacebookListing(normalized);
  const extracted = { ...extractedBase, ...normalized.overrides, originalUrl: extractedBase.originalUrl, images: extractedBase.images, flags: normalized.analysisFlags ?? extractedBase.flags, confidence: typeof normalized.analysisConfidence === "number" ? Math.max(0, Math.min(1, normalized.analysisConfidence)) : extractedBase.confidence, fieldConfidence: { ...extractedBase.fieldConfidence, ...normalized.analysisFieldConfidence }, listingIntent: intent.intent, intentConfidence: intent.confidence, intentSource: intent.intentSource, imageAssessments: normalized.imageAssessments ?? extractedBase.imageAssessments };
  let locationResolution = reconcileFacebookLocation(extracted, { authoritativeText: normalized.postText, groupName: normalized.groupName, groupUrl: normalized.url });
  Object.assign(extracted, locationResolution.property);
  const classification = classifyFacebookProperty(extracted, normalized.postText);
  if (context && !classification.usable) {
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], notProperty: { realEstateLanguage: classification.realEstateLanguage, structuredFieldCount: classification.structuredFieldCount, detectedFields: classification.detectedFields } };
  }
  const buildingEvidence = resolveFacebookBuildingEvidence(normalized.postText, extracted);
  const apartmentSafety = context ? evaluateFacebookApartmentSafety({ authoritativeText: normalized.postText, property: extracted, filter: context.filter, buildingEvidence }) : null;
  if (context && apartmentSafety && apartmentSafety.hardReject) {
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: apartmentSafety.reasons, notProperty: { realEstateLanguage: true, structuredFieldCount: classification.structuredFieldCount, detectedFields: classification.detectedFields, classification: "non_sale_intent", reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED" } };
  }
  const hash = createHash("sha256").update([normalized.postText, extracted.price, extracted.area, extracted.neighborhood].join("|")).digest("hex");
  const sourceUrl = extracted.originalUrl ?? (context ? facebookPostUrl(context.groupUrl, context.postId) : `manual:${hash}`);
  const externalId = context?.postId ?? extracted.originalUrl?.match(/(?:posts|videos)\/(\d+)/)?.[1] ?? hash.slice(0, 32);
  const supabase = createFacebookWatcherAdminClient();
  const existing = await findExisting(supabase, extracted, sourceUrl, externalId, hash);
  const now = context?.checkedAt ?? new Date().toISOString();
  if (context) return importAutomatedFacebook({ supabase, normalized, extracted, context, sourceUrl, externalId, existing, now, buildingType: apartmentSafety?.buildingType ?? null, buildingEvidence });
  let listingId = existing?.id;
  const status: "created" | "updated" = existing ? "updated" : "created";
  const crossSourceMatch = Boolean(existing && existing.source !== "facebook");
  const existingListingState = listingId ? await readListingState(supabase, listingId) : emptyListingState();
  const previousSource = await readSourceMetadata(supabase, sourceUrl);
  const previousMetadata = previousSource.metadata;
  if (existing && !crossSourceMatch) {
    const qualityMerge = mergeFacebookPropertyByConfidence({
      values: listingStateValues(existingListingState, previousMetadata),
      confidence: num(previousMetadata.confidence) ?? 0,
      fieldConfidence: parseFacebookFieldConfidence(previousMetadata.fieldConfidence),
    }, extracted);
    locationResolution = reconcileFacebookLocation(qualityMerge.property, { authoritativeText: normalized.postText, groupName: normalized.groupName, groupUrl: normalized.url });
    Object.assign(extracted, locationResolution.property);
  }
  const existingImages = existingListingState.images;
  const pricePerSqm = extracted.price && extracted.area ? extracted.price / extracted.area : null;
  const score = calculateFlipScore({ price: extracted.price, pricePerSqm, averagePricePerSqm: null, rooms: extracted.rooms, area: extracted.area, marketType: extracted.marketType, title: extracted.title, description: extracted.description }).score;

  if (!listingId) {
    const storedUrl = extracted.originalUrl ?? `https://www.facebook.com/flip-manager/manual/${hash}`;
    const { data, error } = await supabase.from("listings").insert({ source: "facebook", external_listing_id: externalId, original_url: storedUrl, normalized_url: extracted.originalUrl, title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), address: extracted.street, district: extracted.district, city: extracted.city, description: extracted.description, images: [], status: "active", removed_at: null, content_hash: hash, flip_score: score, last_seen_at: now }).select("id").single();
    if (error || !data?.id) throw new Error(`Nie udało się zapisać oferty Facebooka: ${error?.message ?? "brak ID"}`);
    listingId = String(data.id);
  } else if (!crossSourceMatch) {
    const { error } = await supabase.from("listings").update({ title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rooms: extracted.rooms, district: extracted.district, city: extracted.city, description: extracted.description, status: "active", removed_at: null, flip_score: score, last_seen_at: now }).eq("id", listingId);
    if (error) throw new Error(`Nie udało się zaktualizować oferty: ${error.message}`);
  }
  const imageMirror = await mirrorFacebookImages({ listingId, imageUrls: extracted.images, existingImages });
  extracted.images = imageMirror.images;
  const { error: imagesError } = await supabase.from("listings").update({ images: imageMirror.images }).eq("id", listingId);
  if (imagesError) throw new Error(`Nie udało się zapisać stabilnych zdjęć Facebooka: ${imagesError.message}`);
  const { error: metadataError } = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: normalized.groupName ?? null, author_name: normalized.authorName ?? null, published_at: normalized.publishedAt ?? previousSource.publishedAt, collected_at: now, metadata: { ...previousMetadata, source: "facebook_watcher", firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingListingState.firstSeenAt ?? now, neighborhood: extracted.neighborhood, locationProvenance: locationResolution.provenance, confidence: extracted.confidence, fieldConfidence: extracted.fieldConfidence, listingIntent: extracted.listingIntent, intentConfidence: extracted.intentConfidence, intentSource: extracted.intentSource, flags: extracted.flags, sellerType: extracted.sellerType, condition: extracted.condition, opportunityScore: score, crossSourceMatch, imageMirror: imageMirror.stats, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadataError) throw new Error(`Nie udało się zapisać metadanych Facebooka: ${metadataError.message}`);
  await applyFilters(supabase, listingId, extracted, pricePerSqm);
  await recordFacebookGroupImport(normalized.groupName, status === "created", score >= 85 || extracted.sellerType === "private" && extracted.condition === "renovation");
  return { status, listingId, extracted, opportunityScore: score, listingCreated: status === "created", listingUpdated: status === "updated", matched: false, matchCreated: false, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops: 0, warnings: imageMirror.warnings };
}

function skippedFacebookProperty(input: FacebookListingInput, listingIntent: NonNullable<FacebookProperty["listingIntent"]>, intentConfidence: number, intentSource: NonNullable<FacebookProperty["intentSource"]>): FacebookProperty {
  return {
    title: "Post Facebook pominięty", city: null, district: null, neighborhood: null, street: null,
    price: null, area: null, rooms: null, floor: null, totalFloors: null, marketType: null,
    sellerType: null, condition: null, description: null, originalUrl: input.url ?? null, images: [],
    confidence: 0, fieldConfidence: {}, flags: [], listingIntent, intentConfidence, intentSource, imageAssessments: [],
  };
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
  buildingType: string | null;
  buildingEvidence: FacebookBuildingEvidence;
}): Promise<FacebookImportResult> {
  const { supabase, normalized, extracted, context, sourceUrl, externalId, existing, now, buildingType, buildingEvidence } = input;
  const crossSourceMatch = Boolean(existing && existing.source !== "facebook");
  const existingState = existing ? await readListingState(supabase, existing.id) : emptyListingState();
  const previousSource = await readSourceMetadata(supabase, sourceUrl);
  const previousMetadata = previousSource.metadata;
  const qualityMerge = mergeFacebookPropertyByConfidence(existing && !crossSourceMatch ? {
    values: listingStateValues(existingState, previousMetadata),
    confidence: num(previousMetadata.confidence) ?? 0,
    fieldConfidence: parseFacebookFieldConfidence(previousMetadata.fieldConfidence),
  } : null, extracted);
  const locationResolution = reconcileFacebookLocation(qualityMerge.property, { authoritativeText: normalized.postText, groupName: context.groupName, groupUrl: normalized.url ?? context.groupUrl });
  const effective = locationResolution.property;
  if (effective.listingIntent !== "SELL_PROPERTY") throw new Error("FACEBOOK_INTENT_GATE_FAILED");
  const boundImages = exactBoundPropertyImages(normalized, externalId);
  for (const candidate of normalized.mediaCandidates ?? []) {
    if (candidate.classification === "PROPERTY_IMAGE" && !hasApprovedFacebookImageProvenance(candidate, externalId)) {
      console.info("FACEBOOK_IMAGE_PROVENANCE_REJECTED", {
        sourcePostId: candidate.expectedPostId,
        storyRootPostIdPresent: candidate.storyRootPostId !== null && candidate.storyRootPostId !== undefined,
        bindingMethod: candidate.bindingProvenance,
        bindingConfidence: candidate.bindingConfidence,
        classification: candidate.classification,
        classificationConfidence: candidate.classificationConfidence,
        rejectionReason: "FACEBOOK_IMAGE_PROVENANCE_INSUFFICIENT",
      });
    }
  }
  effective.images = boundImages;
  // A verified extraction is authoritative for the current Facebook post. Never
  // carry forward unproven images from an older extraction/cache entry.
  const preserveExistingImages = context.preserveExistingImagesOnEmptyInput === true && boundImages.length === 0;
  const imageMirror = await mirrorFacebookImages({ listingId: externalId, imageUrls: boundImages, existingImages: existingState.images, preserveExistingImages });
  effective.images = imageMirror.images;
  const pricePerSqm = effective.price && effective.area ? effective.price / effective.area : null;
  const score = calculateFlipScore({ price: effective.price, pricePerSqm, averagePricePerSqm: null, rooms: effective.rooms, area: effective.area, marketType: effective.marketType, title: effective.title, description: effective.description }).score;
  const locationText = [effective.street, effective.neighborhood, effective.district, effective.city].filter(Boolean).join(", ") || null;
  const baseDecision = evaluateListingAgainstFilter({ price: effective.price, area: effective.area, pricePerSqm, rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), city: effective.city, district: effective.district, title: effective.title, locationText, buildingType, sellerType: effective.sellerType, marketType: effective.marketType, ownership: null }, context.filter);
  const safetyUnknown = apartmentUnknownFields(context.filter, buildingEvidence, effective.city);
  const decisionUnknownFields = [...new Set([...baseDecision.unknownFields, ...safetyUnknown])];
  const decision = { ...baseDecision, unknownFields: decisionUnknownFields, missingFields: decisionUnknownFields, bucket: decisionBucket({ reasons: baseDecision.reasons, unknownFields: decisionUnknownFields }), matches: baseDecision.reasons.length === 0 && decisionUnknownFields.length === 0 };
  let listingId: string;
  let listingCreated = false;
  let listingUpdated = false;
  let matchCreated = false;
  let priceDrops = 0;
  const manualRejected = existingState.manualDecision === "REJECTED";

  if (crossSourceMatch && existing) {
    listingId = existing.id;
    const imagesUpdate = await supabase.from("listings").update({ images: imageMirror.images }).eq("id", listingId);
    if (imagesUpdate.error) throw new Error(`FACEBOOK_IMAGE_PERSIST_FAILED: ${imagesUpdate.error.message}`);
    let lifecycleUpdate = await supabase.from("listings").update({ lifecycle_status: manualRejected ? "REJECTED" : decision.bucket === "MATCHED" ? "ACTIVE" : decision.bucket, review_reason: !manualRejected && decision.bucket === "REVIEW" ? `Brak danych: ${decision.unknownFields.join(", ")}` : null, missing_fields: !manualRejected && decision.bucket === "REVIEW" ? decision.unknownFields : [], last_seen_at: now, status: "active", archived_at: manualRejected ? existingState.archivedAt ?? now : null }).eq("id", listingId);
    if (lifecycleUpdate.error?.code === "42703") lifecycleUpdate = await supabase.from("listings").update({ last_seen_at: now, status: "active" }).eq("id", listingId);
    if (lifecycleUpdate.error) throw new Error(`FACEBOOK_LIFECYCLE_PERSIST_FAILED: ${lifecycleUpdate.error.message}`);
    if (decision.matches && !manualRejected) matchCreated = await upsertAutomatedMatch(supabase, listingId, context, decision.unknownFields, now);
    else if (decision.bucket === "REVIEW" && !manualRejected) {
      const review = await supabase.from("listing_filter_matches").upsert({ listing_id: listingId, search_filter_id: context.filter.id, last_matched_at: now, is_current_match: false, match_reasons: ["review", ...decision.unknownFields.map((field) => `unknown_${field}`)], match_origin: "scan", source_scan_id: context.sourceScanId }, { onConflict: "listing_id,search_filter_id" });
      if (review.error) throw new Error(`FACEBOOK_REVIEW_PERSIST_FAILED: ${review.error.message}`);
    } else await deactivateListingFilterMatch(supabase, listingId, context.filter.id);
  } else {
    const rawPayload = { source: "facebook", postId: context.postId, groupId: context.groupId, groupName: context.groupName, publishedAt: preserveFacebookPublishedAt(normalized.publishedAt, previousSource.publishedAt), authoritativeTextSource: normalized.postText ? "AUTHOR_TEXT" : null, mediaBinding: facebookMediaBindingSummary(normalized, externalId), buildingEvidence, flags: effective.flags, listingIntent: effective.listingIntent, intentConfidence: effective.intentConfidence, intentSource: effective.intentSource, locationProvenance: locationResolution.provenance, discoverySource: normalized.discoverySource ?? "MAIN_FEED", searchQuery: normalized.searchQuery ?? null, searchQueries: normalized.searchQueries ?? [], foundInMainFeed: normalized.foundInMainFeed === true, firstSeenPhase: normalized.firstSeenPhase ?? "MAIN_FEED" };
    const contentHash = calculateContentHash({ title: effective.title, description: effective.description, price: effective.price, area: effective.area, rooms: effective.rooms, floor: effective.floor, locationText, images: imageMirror.images });
    const listing: SourceListing = { source: "facebook", externalListingId: externalId, originalUrl: sourceUrl, normalizedUrl: sourceUrl, title: effective.title, price: effective.price, area: effective.area, rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), pricePerSqm, city: effective.city, district: effective.district, locationText, images: imageMirror.images, thumbnailUrl: imageMirror.images[0] ?? null, buildingType, description: effective.description, rawPayload, contentHash };
    const saved = await persistListing(supabase, context.filter.id, listing, decision.matches, decision.unknownFields, context.sourceScanId, now, AbortSignal.timeout(75_000), decision);
    listingId = saved.listingId;
    listingCreated = saved.listingCreated;
    listingUpdated = saved.updated > 0;
    matchCreated = saved.matchCreated;
    priceDrops = saved.priceDrop;
    const scoreUpdate = await supabase.from("listings").update({ flip_score: score }).eq("id", listingId);
    if (scoreUpdate.error) throw new Error(`FACEBOOK_SCORE_PERSIST_FAILED: ${scoreUpdate.error.message}`);
  }

  if (crossSourceMatch) {
    const sidecarListing: SourceListing = {
      source: "facebook",
      externalListingId: externalId,
      originalUrl: sourceUrl,
      normalizedUrl: sourceUrl,
      title: effective.title,
      price: effective.price,
      area: effective.area,
      rooms: effective.rooms,
      floor: effective.floor === null ? null : String(effective.floor),
      pricePerSqm,
      city: effective.city,
      district: effective.district,
      locationText,
      images: imageMirror.images,
      thumbnailUrl: imageMirror.images[0] ?? null,
      buildingType,
      description: effective.description,
      rawPayload: {},
      contentHash: calculateContentHash({ title: effective.title, price: effective.price, area: effective.area, rooms: effective.rooms, locationText }),
    };
    void syncResaleCompFromListing(supabase, sidecarListing, listingId, now).catch((reason) => {
      console.warn("RESALE_COMP_SYNC_DEFERRED", { source: "facebook", externalListingId: externalId, error: reason instanceof Error ? reason.message : "unknown" });
    });
  }

  const persistedPublishedAt = preserveFacebookPublishedAt(normalized.publishedAt, previousSource.publishedAt);
  const bindingSummary = facebookMediaBindingSummary(normalized, externalId);
  const mediaProvenance = (normalized.mediaCandidates ?? []).map((candidate) => ({
    sourcePostId: candidate.expectedPostId,
    storyRootPostId: candidate.storyRootPostId ?? null,
    bindingMethod: candidate.bindingProvenance,
    bindingConfidence: candidate.bindingConfidence,
    classification: candidate.classification,
    classificationConfidence: candidate.classificationConfidence,
  }));
  const metadata = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: context.groupName, author_name: null, published_at: persistedPublishedAt, collected_at: now, metadata: { ...previousMetadata, source: "facebook_worker", groupId: context.groupId, groupName: context.groupName, postId: context.postId, importedAt: str(previousMetadata.importedAt) ?? now, checkedAt: now, firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingState.firstSeenAt ?? now, neighborhood: effective.neighborhood, locationProvenance: locationResolution.provenance, buildingEvidence, confidence: effective.confidence, fieldConfidence: effective.fieldConfidence, fieldProvenance: facebookFieldProvenance(normalized, effective), sourceFacts: effective.sourceFacts, authoritativeSourceText: normalized.postText ?? null, listingIntent: effective.listingIntent, intentConfidence: effective.intentConfidence, intentSource: effective.intentSource, flags: effective.flags, sellerType: effective.sellerType, condition: effective.condition, opportunityScore: score, crossSourceMatch, discoverySource: normalized.discoverySource ?? "MAIN_FEED", searchQuery: normalized.searchQuery ?? null, searchQueries: normalized.searchQueries ?? [], foundInMainFeed: normalized.foundInMainFeed === true, firstSeenPhase: normalized.firstSeenPhase ?? "MAIN_FEED", mediaBinding: bindingSummary, mediaProvenance, imageExtractionVersion: 2, imageMirror: imageMirror.stats, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadata.error) throw new Error(`FACEBOOK_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  console.info("FACEBOOK_MEDIA_BINDING_SUMMARY", { postId: externalId, ...bindingSummary, mirrored: imageMirror.images.length });
  console.info("FACEBOOK_PUBLICATION_DATE", { postId: externalId, source: normalized.publishedAt ? "FACEBOOK_CREATION_TIME" : previousSource.publishedAt ? "EXISTING_DATA" : "UNKNOWN", exact: Boolean(normalized.publishedAt), persisted: persistedPublishedAt });
  await recordFacebookGroupImport(context.groupName, listingCreated, score >= 85 || effective.sellerType === "private" && effective.condition === "renovation");
  const relevanceAccepted = normalized.imageAssessments?.filter((assessment) => assessment.relevance === "PROPERTY_IMAGE" && assessment.confidence >= 0.8).length ?? effective.images.length;
  const persistenceDiagnostics = facebookImagePersistenceDiagnostics({
    postId: externalId,
    creationTime: normalized.publishedAt ?? null,
    timestampSource: normalized.publishedAt ? "POST_PAGE_METADATA" as const : "UNKNOWN" as const,
    publishedAtCandidate: normalized.publishedAt ?? null,
    publishedAtPersistAttempted: true,
    publishedAtPersisted: !metadata.error,
    exactBoundCandidates: bindingSummary.exactBound,
    relevanceAccepted,
    mirrorAttempted: boundImages.length,
    mirroredCount: imageMirror.stats.uploadedCount,
    existingImages: existingState.images,
    finalListingImages: imageMirror.images,
    imageProvenance: facebookImageProvenanceDiagnostics(normalized.mediaCandidates ?? [], externalId, new Set(boundImages)),
  });
  return { status: listingCreated ? "created" : "updated", listingId, extracted: effective, opportunityScore: score, listingCreated, listingUpdated, matched: decision.matches, matchCreated, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops, warnings: [...imageMirror.warnings, ...facebookNoMatchWarnings(decision.matches, decision.reasons)], persistenceDiagnostics };
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

function apartmentUnknownFields(filter: SearchFilter, evidence: FacebookBuildingEvidence, city: string | null): string[] {
  const fields: string[] = [];
  if (evidence.status === "UNVERIFIED") fields.push("buildingType");
  if (filter.city && !city) fields.push("city");
  return fields;
}

function facebookPostUrl(groupUrl: string, postId: string | null): string {
  if (!postId) throw new Error("FACEBOOK_POST_ID_REQUIRED");
  const base = new URL(groupUrl); base.pathname = `${base.pathname.replace(/\/$/, "")}/posts/${encodeURIComponent(postId)}/`; base.search = ""; base.hash = "";
  return base.toString();
}

function facebookFieldProvenance(input: FacebookListingInput, property: FacebookProperty): Row {
  const source = input.postText ? "AUTHOR_TEXT" : "VISION";
  return Object.fromEntries(["title", "description", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType"]
    .filter((field) => property[field as keyof FacebookProperty] !== null && property[field as keyof FacebookProperty] !== undefined)
    .map((field) => [field, field === "price" && property.priceProvenance ? property.priceProvenance : field === "description" && input.postText ? "AUTHOR_TEXT" : source]));
}

async function readSourceMetadata(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, sourceUrl: string): Promise<{ metadata: Row; publishedAt: string | null }> {
  const { data, error } = await supabase.from("listing_source_metadata").select("metadata,published_at").eq("source", "facebook").eq("source_post_url", sourceUrl).maybeSingle();
  if (error) throw new Error(`Nie udało się odczytać metadanych workflow Facebooka: ${error.message}`);
  return { metadata: data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata as Row : {}, publishedAt: str(data?.published_at) };
}

type FacebookListingState = {
  images: string[]; firstSeenAt: string | null; title: string | null; price: number | null;
  area: number | null; rooms: number | null; floor: number | null; address: string | null;
  district: string | null; city: string | null; description: string | null;
  manualDecision: "ACCEPTED" | "REJECTED" | null; lifecycleStatus: string | null; archivedAt: string | null;
};

async function readListingState(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, listingId: string): Promise<FacebookListingState> {
  let result = await supabase.from("listings").select("images,first_seen_at,title,price,area,rooms,floor,address,district,city,description,manual_decision,lifecycle_status,archived_at").eq("id", listingId).maybeSingle();
  if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
    result = await supabase.from("listings").select("images,first_seen_at,title,price,area,rooms,floor,address,district,city,description").eq("id", listingId).maybeSingle();
  }
  const { data, error } = result;
  if (error) throw new Error(`Nie udało się odczytać istniejących zdjęć oferty: ${error.message}`);
  return {
    images: Array.isArray(data?.images) ? data.images.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [],
    firstSeenAt: str(data?.first_seen_at), title: str(data?.title), price: num(data?.price), area: num(data?.area),
    rooms: num(data?.rooms), floor: num(data?.floor), address: str(data?.address), district: str(data?.district),
    city: str(data?.city), description: str(data?.description),
    manualDecision: data?.manual_decision === "ACCEPTED" || data?.manual_decision === "REJECTED" ? data.manual_decision : null,
    lifecycleStatus: str(data?.lifecycle_status), archivedAt: str(data?.archived_at),
  };
}

function emptyListingState(): FacebookListingState {
  return { images: [], firstSeenAt: null, title: null, price: null, area: null, rooms: null, floor: null, address: null, district: null, city: null, description: null, manualDecision: null, lifecycleStatus: null, archivedAt: null };
}

function listingStateValues(state: FacebookListingState, metadata: Row) {
  return {
    title: state.title, description: state.description, city: state.city, district: state.district,
    neighborhood: str(metadata.neighborhood), street: state.address, price: state.price, area: state.area,
    rooms: state.rooms, floor: state.floor, totalFloors: null, condition: facebookCondition(metadata.condition, []),
    sellerType: facebookSellerType(metadata.sellerType, []),
  };
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
