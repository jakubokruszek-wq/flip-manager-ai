import "server-only";

import { createHash } from "node:crypto";
import { calculateFlipScore } from "@/features/flip-score/calculate-flip-score";
import { evaluateCanonicalListingDecision } from "@/features/flip-finder/filter-evaluation";
import { decisionBucket } from "@/features/flip-finder/decision-model";
import { calculateContentHash } from "@/features/flip-finder/otodom-search";
import { persistListing } from "@/features/flip-finder/server/persist-listing";
import { reconcileCanonicalListingDecision } from "@/features/flip-finder/server/canonical-reconciliation";
import { getActiveSearchFiltersForSource } from "@/features/flip-finder/server/search-filters";
import { classifyFacebookRestore } from "./restore-to-finder";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import type { SearchFilter } from "@/features/flip-finder";
import { classifyFacebookProperty, extractFacebookListing } from "./extract-facebook-listing";
import type { FacebookProperty } from "./types";
import { manualFacebookAdapter } from "./facebook-source-adapter";
import { createFacebookWatcherAdminClient } from "./supabase-admin";
import { isLikelySameFacebookProperty } from "./deduplicate-facebook-listing";
import { mirrorFacebookImages } from "./server/mirror-facebook-images";
import { dataFirstFacebookImageResult, type FacebookImageMode } from "./facebook-image-mode";
import { FACEBOOK_WORKFLOW_STATUSES, type FacebookListingInput, type FacebookWatcherListing, type FacebookWorkflowStatus } from "./types";
import { recordFacebookGroupImport } from "@/features/facebook-groups/server";
import { facebookNoMatchWarnings, mergeFacebookPropertyByConfidence, parseFacebookFieldConfidence } from "./facebook-data-quality";
import { resolveFacebookListingIntent } from "./facebook-intent";
import { composeFacebookLocation, reconcileFacebookLocation } from "./facebook-location-quality";
import { exactBoundPropertyImages, facebookImagePersistenceDiagnostics, facebookImageProvenanceDiagnostics, facebookMediaBindingSummary, hasApprovedFacebookImageProvenance, preserveFacebookPublishedAt } from "./facebook-media-binding";
import type { FacebookPersistenceDiagnostics } from "../facebook-worker/post-flow";
import { evaluateFacebookApartmentSafety } from "./facebook-apartment-safety";
import { resolveFacebookBuildingEvidence, type FacebookBuildingEvidence } from "./facebook-building-evidence";
import { syncResaleCompFromListing } from "@/features/market-intelligence/resale-comps-store";
import { shouldAutoEnrichFacebookImages } from "./auto-image-enrichment";
import { enqueueFacebookGalleryJob } from "../facebook-worker/gallery-jobs";
import { assessFacebookListingQuality, assessFacebookPriceQuality, FACEBOOK_PRICE_CATEGORIES, FACEBOOK_PRICE_SOURCES, FACEBOOK_PRICE_STATUSES, isFacebookPriceSuspect, PRICE_SUSPECT_SCORE_CAP, type FacebookListingQualityGrade, type FacebookPriceCategory, type FacebookPriceQuality, type FacebookPriceSource, type FacebookPriceStatus } from "./price-quality";
import { assessFacebookContentQuality, classifyFacebookAvailability, classifyFacebookFreshness, classifyFacebookLocationState, classifyFacebookPropertyType, classifyFacebookSearchIntent, FACEBOOK_AVAILABILITY_STATES, FACEBOOK_CONTENT_QUALITY_GRADES, FACEBOOK_FRESHNESS_STATES, FACEBOOK_LOCATION_STATES, FACEBOOK_PROPERTY_TYPES, FACEBOOK_SEARCH_INTENTS } from "./search-quality";
import { classifyFacebookPostAgeZone } from "./post-age-zone";
import { resolveFacebookPricePerSqm } from "./extract-facebook-property";
import { isFacebookOrphan, orphanDiagnostic, type FacebookOrphanDiagnostic } from "./facebook-orphan-recovery";
import { facebookPersistenceFailure } from "./facebook-persistence-contract";

type Row = Record<string, unknown>;

/** The active-listing candidate shape `findExisting` fuzzy-matches against. */
export type FacebookActiveListingCandidate = { id: string; source: string; title: string | null; price: number | null; area: number | null; district: string | null; address: string | null };

/**
 * Fetches the active-listings candidate set once for an entire scan/batch.
 * `findExisting` used to run this same query, unfiltered, for every single
 * post — a fixed cost repeated N times per scan instead of once.
 */
export async function fetchFacebookActiveListingCandidates(): Promise<FacebookActiveListingCandidate[]> {
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.from("listings").select("id,source,title,price,area,district,address").eq("status", "active").limit(500);
  if (error) throw new Error(`Nie udało się pobrać aktywnych ofert do porównania: ${error.message}`);
  return (data ?? []).map((row) => ({ id: String(row.id), source: String(row.source), title: str(row.title), price: num(row.price), area: num(row.area), district: str(row.district), address: str(row.address) }));
}

export type FacebookAutomatedImportContext = {
  filter: SearchFilter;
  sourceScanId: string;
  groupId: string;
  groupName: string;
  groupUrl: string;
  postId: string | null;
  checkedAt: string;
  /** Pre-fetched once per scan/batch by the caller; see `fetchFacebookActiveListingCandidates`. */
  activeListingsCache?: FacebookActiveListingCandidate[];
  preserveExistingImagesOnEmptyInput?: boolean;
  imageMode?: FacebookImageMode;
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
  persistenceDiagnostics?: FacebookPersistenceDiagnostics;
  notProperty?: {
    realEstateLanguage: boolean;
    structuredFieldCount: number;
    detectedFields: string[];
    classification?: "not_a_property" | "non_sale_intent";
    reasonCode?: import("../facebook-worker/types").FacebookSkipReasonCode;
    listingIntent?: import("../facebook-worker/types").FacebookListingIntent;
    intentSource?: import("../facebook-worker/types").FacebookIntentSource;
  };
};

export async function importFacebookWatcher(input: FacebookListingInput, context?: FacebookAutomatedImportContext): Promise<FacebookImportResult> {
  const normalized = await manualFacebookAdapter.importManual(input);
  if (classifyFacebookPostAgeZone(normalized.publishedAt) === "OLD") return staleFacebookImportResult(normalized);
  const intent = resolveFacebookListingIntent(normalized.postText, normalized.listingIntent, normalized.intentConfidence);
  if (context && intent.intent !== "SELL_PROPERTY") {
    const extracted = skippedFacebookProperty(normalized, intent.intent, intent.confidence, intent.intentSource);
    const realEstateLanguage = intent.intent === "BUY_PROPERTY" || intent.intent === "RENT_OFFER" || intent.intent === "RENT_WANTED";
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], notProperty: { realEstateLanguage, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent", reasonCode: intent.reasonCode ?? "FACEBOOK_INTENT_UNKNOWN" } };
  }
  // A SELL-intent post can still be a house/land/commercial listing — the intent
  // classifier only sees sell-vs-rent-vs-buy, never what kind of property it is.
  const automatedPropertyType = classifyFacebookPropertyType(normalized.postText ?? "");
  const automatedAvailability = classifyFacebookAvailability(normalized.postText ?? "");
  const hardPropertyReject = automatedPropertyType === "HOUSE" || automatedPropertyType === "LAND" || automatedPropertyType === "COMMERCIAL" || automatedPropertyType === "ROOM" || automatedPropertyType === "GARAGE";
  if (context && hardPropertyReject) {
    const extracted = skippedFacebookProperty(normalized, intent.intent, intent.confidence, intent.intentSource);
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], notProperty: { realEstateLanguage: true, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent", reasonCode: "FACEBOOK_NON_APARTMENT_PROPERTY" } };
  }
  if (context && automatedAvailability !== "ACTIVE") {
    const extracted = skippedFacebookProperty(normalized, intent.intent, intent.confidence, intent.intentSource);
    return { status: "skipped", listingId: null, extracted, opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [`FACEBOOK_AVAILABILITY_${automatedAvailability}`], notProperty: { realEstateLanguage: true, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent", reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED" } };
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
  const existing = await findExisting(supabase, extracted, sourceUrl, externalId, hash, context?.activeListingsCache);
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
  const pricePerSqm = resolveFacebookPricePerSqm(extracted);
  const priceQuality = assessFacebookPriceQuality({ price: extracted.price, area: extracted.area, sourceFacts: extracted.sourceFacts, listingIntent: extracted.listingIntent, priceProvenance: extracted.priceProvenance, postText: normalized.postText ?? null, visionPrice: extracted.visionPriceCandidate ?? null });
  const listingQuality = assessFacebookListingQuality({ priceQuality, area: extracted.area, city: extracted.city, district: extracted.district, street: extracted.street, originalUrl: extracted.originalUrl });
  const propertyType = classifyFacebookPropertyType(normalized.postText ?? "");
  const searchIntent = classifyFacebookSearchIntent(normalized.postText ?? "", { intent: extracted.listingIntent ?? "UNKNOWN" });
  const availability = classifyFacebookAvailability(normalized.postText ?? "");
  const freshness = classifyFacebookFreshness(normalized.publishedAt ?? previousSource.publishedAt);
  const locationState = classifyFacebookLocationState({ city: extracted.city, district: extracted.district, neighborhood: extracted.neighborhood, conflict: locationResolution.provenance.conflict });
  const contentQuality = assessFacebookContentQuality({ searchIntent, propertyType, priceStatus: priceQuality.status, areaKnown: extracted.area !== null, locationState, freshness, availability });
  const rawScore = calculateFlipScore({ price: extracted.price, pricePerSqm, averagePricePerSqm: null, rooms: extracted.rooms, area: extracted.area, marketType: extracted.marketType, title: extracted.title, description: extracted.description }).score;
  const score = isFacebookPriceSuspect(priceQuality.status) ? Math.min(rawScore, PRICE_SUSPECT_SCORE_CAP) : rawScore;
  const rent = extracted.sourceFacts?.administrativeRent ?? null;

  if (!listingId) {
    const storedUrl = extracted.originalUrl ?? `https://www.facebook.com/flip-manager/manual/${hash}`;
    const { data, error } = await supabase.from("listings").insert({ source: "facebook", external_listing_id: externalId, original_url: storedUrl, normalized_url: extracted.originalUrl, title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rent, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), address: extracted.street, district: extracted.district, city: extracted.city, description: extracted.description, images: [], status: "active", removed_at: null, content_hash: hash, flip_score: score, last_seen_at: now }).select("id").single();
    if (error || !data?.id) throw new Error(`Nie udało się zapisać oferty Facebooka: ${error?.message ?? "brak ID"}`);
    listingId = String(data.id);
  } else if (!crossSourceMatch) {
    const { error } = await supabase.from("listings").update({ title: extracted.title, price: extracted.price, area: extracted.area, price_per_sqm: pricePerSqm, rent, rooms: extracted.rooms, district: extracted.district, city: extracted.city, description: extracted.description, status: "active", removed_at: null, flip_score: score, last_seen_at: now }).eq("id", listingId);
    if (error) throw new Error(`Nie udało się zaktualizować oferty: ${error.message}`);
  }
  const imageMirror = await mirrorFacebookImages({ listingId, imageUrls: extracted.images, existingImages });
  extracted.images = imageMirror.images;
  const { error: imagesError } = await supabase.from("listings").update({ images: imageMirror.images }).eq("id", listingId);
  if (imagesError) throw new Error(`Nie udało się zapisać stabilnych zdjęć Facebooka: ${imagesError.message}`);
  const { error: metadataError } = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: normalized.groupName ?? null, author_name: normalized.authorName ?? null, published_at: normalized.publishedAt ?? previousSource.publishedAt, collected_at: now, metadata: { ...previousMetadata, source: "facebook_watcher", firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingListingState.firstSeenAt ?? now, neighborhood: extracted.neighborhood, locationProvenance: locationResolution.provenance, confidence: extracted.confidence, fieldConfidence: extracted.fieldConfidence, sourceFacts: extracted.sourceFacts, priceQuality, listingQuality: listingQuality.listingQuality, searchIntent, propertyType, availability, freshness, locationState, contentQuality, listingIntent: extracted.listingIntent, intentConfidence: extracted.intentConfidence, intentSource: extracted.intentSource, flags: extracted.flags, sellerType: extracted.sellerType, condition: extracted.condition, opportunityScore: score, crossSourceMatch, imageMirror: imageMirror.stats, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadataError) throw new Error(`Nie udało się zapisać metadanych Facebooka: ${metadataError.message}`);
  const filterDecisions = await applyFilters(supabase, listingId, extracted, pricePerSqm);
  for (const filterDecision of filterDecisions) await assertFacebookPersistenceComplete(supabase, listingId, filterDecision.filterId, sourceUrl, filterDecision);
  await recordFacebookGroupImport(normalized.groupName, status === "created", score >= 85 || extracted.sellerType === "private" && extracted.condition === "renovation");
  return { status, listingId, extracted, opportunityScore: score, listingCreated: status === "created", listingUpdated: status === "updated", matched: false, matchCreated: false, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops: 0, warnings: imageMirror.warnings };
}

function staleFacebookImportResult(input: FacebookListingInput): FacebookImportResult {
  const listingIntent = input.listingIntent ?? "UNKNOWN";
  const intentSource = input.intentSource ?? "UNKNOWN";
  return {
    status: "skipped", listingId: null, extracted: skippedFacebookProperty(input, listingIntent, input.intentConfidence ?? 0, intentSource),
    opportunityScore: 0, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false,
    imagesMirrored: 0, priceDrops: 0, warnings: [],
    notProperty: {
      realEstateLanguage: true, structuredFieldCount: 0, detectedFields: [], classification: "non_sale_intent",
      reasonCode: "FACEBOOK_STALE_POST_OLDER_THAN_72H", listingIntent, intentSource,
    },
  };
}

function skippedFacebookProperty(input: FacebookListingInput, listingIntent: NonNullable<FacebookProperty["listingIntent"]>, intentConfidence: number, intentSource: NonNullable<FacebookProperty["intentSource"]>): FacebookProperty {
  return {
    title: "Post Facebook pominięty", city: null, district: null, neighborhood: null, street: null,
    price: null, pricePerM2: null, area: null, rooms: null, floor: null, totalFloors: null, marketType: null,
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
  const dataFirstSearch = context.imageMode === "SEARCH_DATA_FIRST";
  const imageMirror = dataFirstSearch
    ? dataFirstFacebookImageResult(existingState.images, boundImages.length)
    : await mirrorFacebookImages({ listingId: externalId, imageUrls: boundImages, existingImages: existingState.images, preserveExistingImages });
  effective.images = imageMirror.images;
  const pricePerSqm = resolveFacebookPricePerSqm(effective);
  const priceQuality = assessFacebookPriceQuality({ price: effective.price, area: effective.area, sourceFacts: effective.sourceFacts, listingIntent: effective.listingIntent, priceProvenance: effective.priceProvenance, postText: normalized.postText ?? null, visionPrice: effective.visionPriceCandidate ?? null });
  const listingQuality = assessFacebookListingQuality({ priceQuality, area: effective.area, city: effective.city, district: effective.district, street: effective.street, originalUrl: effective.originalUrl });
  const propertyType = classifyFacebookPropertyType(normalized.postText ?? "");
  const searchIntent = classifyFacebookSearchIntent(normalized.postText ?? "", { intent: effective.listingIntent ?? "UNKNOWN" });
  const availability = classifyFacebookAvailability(normalized.postText ?? "");
  const freshness = classifyFacebookFreshness(preserveFacebookPublishedAt(normalized.publishedAt, previousSource.publishedAt));
  const locationState = classifyFacebookLocationState({ city: effective.city, district: effective.district, neighborhood: effective.neighborhood, conflict: locationResolution.provenance.conflict });
  const contentQuality = assessFacebookContentQuality({ searchIntent, propertyType, priceStatus: priceQuality.status, areaKnown: effective.area !== null, locationState, freshness, availability });
  const rawScore = calculateFlipScore({ price: effective.price, pricePerSqm, averagePricePerSqm: null, rooms: effective.rooms, area: effective.area, marketType: effective.marketType, title: effective.title, description: effective.description }).score;
  const score = isFacebookPriceSuspect(priceQuality.status) ? Math.min(rawScore, PRICE_SUSPECT_SCORE_CAP) : rawScore;
  const locationText = composeFacebookLocation({ street: effective.street, neighborhood: effective.neighborhood, district: effective.district, city: effective.city });
  const baseDecision = evaluateCanonicalListingDecision({ price: effective.price, area: effective.area, pricePerSqm, rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), city: effective.city, district: effective.district, title: effective.title, locationText, buildingType, sellerType: effective.sellerType, marketType: effective.marketType, ownership: null }, context.filter);
  const safetyUnknown = apartmentUnknownFields(context.filter, buildingEvidence, effective.city);
  const decisionUnknownFields = [...new Set([...baseDecision.missingFields, ...safetyUnknown])];
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
    const lastSeen = await supabase.from("listings").update({ last_seen_at: now, status: "active" }).eq("id", listingId);
    if (lastSeen.error) throw new Error(`FACEBOOK_LIFECYCLE_PERSIST_FAILED: ${lastSeen.error.message}`);
    const canonical = await reconcileFacebookDecision({
      supabase,
      listingId,
      filterId: context.filter.id,
      decision: manualRejected ? { bucket: "REJECTED", reasons: ["manual_rejected"], missingFields: [], hardRejectReasons: ["manual_rejected"] } : decision,
      matchOrigin: "scan",
      sourceScanId: context.sourceScanId,
      matchedAt: now,
    });
    matchCreated = canonical.isCurrentMatch;
  } else {
    const rawPayload = { source: "facebook", postId: context.postId, groupId: context.groupId, groupName: context.groupName, publishedAt: preserveFacebookPublishedAt(normalized.publishedAt, previousSource.publishedAt), authoritativeTextSource: normalized.postText ? "AUTHOR_TEXT" : null, mediaBinding: facebookMediaBindingSummary(normalized, externalId), buildingEvidence, flags: effective.flags, listingIntent: effective.listingIntent, intentConfidence: effective.intentConfidence, intentSource: effective.intentSource, locationProvenance: locationResolution.provenance, discoverySource: normalized.discoverySource ?? "MAIN_FEED", searchQuery: normalized.searchQuery ?? null, searchQueries: normalized.searchQueries ?? [], foundInMainFeed: normalized.foundInMainFeed === true, firstSeenPhase: normalized.firstSeenPhase ?? "MAIN_FEED" };
    const contentHash = calculateContentHash({ title: effective.title, description: effective.description, price: effective.price, area: effective.area, rooms: effective.rooms, floor: effective.floor, locationText, images: imageMirror.images });
    const listing: SourceListing = { source: "facebook", externalListingId: externalId, originalUrl: sourceUrl, normalizedUrl: sourceUrl, title: effective.title, price: effective.price, area: effective.area, rooms: effective.rooms, floor: effective.floor === null ? null : String(effective.floor), pricePerSqm, city: effective.city, district: effective.district, locationText, images: imageMirror.images, thumbnailUrl: imageMirror.images[0] ?? null, buildingType, description: effective.description, rawPayload, contentHash };
    let saved: Awaited<ReturnType<typeof persistListing>>;
    try {
      saved = await persistListing(supabase, context.filter.id, listing, decision.matches, decision.unknownFields, context.sourceScanId, now, AbortSignal.timeout(75_000), decision);
    } catch (error) {
      throw mapFacebookPersistenceError(error);
    }
    listingId = saved.listingId;
    listingCreated = saved.listingCreated;
    listingUpdated = saved.updated > 0;
    matchCreated = saved.matchCreated;
    priceDrops = saved.priceDrop;
    const scoreUpdate = await supabase.from("listings").update({ flip_score: score }).eq("id", listingId);
    if (scoreUpdate.error) throw new Error(`FACEBOOK_SCORE_PERSIST_FAILED: ${scoreUpdate.error.message}`);
    // A pre-fetched cache is a snapshot from before this batch started. Append
    // this newly created listing so a later, differently-worded post about the
    // same property in the SAME batch can still be matched against it — never
    // weaken intra-batch duplicate recall for the sake of the optimization.
    if (listingCreated && context.activeListingsCache) {
      context.activeListingsCache.push({ id: listingId, source: "facebook", title: effective.title, price: effective.price, area: effective.area, district: effective.district, address: locationText });
    }
  }

  if (shouldAutoEnrichFacebookImages({ bucket: manualRejected ? "REJECTED" : decision.bucket, manualRejected, mirroredImageCount: imageMirror.images.length })) {
    void enqueueFacebookGalleryJob(listingId).catch((reason) => {
      console.warn("FACEBOOK_AUTO_GALLERY_ENQUEUE_DEFERRED", { listingId, bucket: decision.bucket, error: reason instanceof Error ? reason.message : "unknown" });
    });
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
    mediaId: candidate.mediaId ?? null,
    sourcePostId: candidate.expectedPostId,
    storyRootPostId: candidate.storyRootPostId ?? null,
    normalizedMediaUrl: candidate.url,
    bindingMethod: candidate.bindingProvenance,
    discoverySource: candidate.discoverySource ?? null,
    bindingConfidence: candidate.bindingConfidence,
    classification: candidate.classification,
    classificationConfidence: candidate.classificationConfidence,
  }));
  const metadata = await supabase.from("listing_source_metadata").upsert({ listing_id: listingId, source: "facebook", source_post_url: sourceUrl, group_name: context.groupName, author_name: null, published_at: persistedPublishedAt, collected_at: now, metadata: { ...previousMetadata, source: "facebook_worker", groupId: context.groupId, groupName: context.groupName, postId: context.postId, importedAt: str(previousMetadata.importedAt) ?? now, checkedAt: now, firstImportedAt: str(previousMetadata.firstImportedAt) ?? existingState.firstSeenAt ?? now, neighborhood: effective.neighborhood, locationProvenance: locationResolution.provenance, buildingEvidence, confidence: effective.confidence, fieldConfidence: effective.fieldConfidence, fieldProvenance: facebookFieldProvenance(normalized, effective), sourceFacts: effective.sourceFacts, priceQuality, listingQuality: listingQuality.listingQuality, searchIntent, propertyType, availability, freshness, locationState, contentQuality, authoritativeSourceText: normalized.postText ?? null, listingIntent: effective.listingIntent, intentConfidence: effective.intentConfidence, intentSource: effective.intentSource, flags: effective.flags, sellerType: effective.sellerType, condition: effective.condition, opportunityScore: score, crossSourceMatch, discoverySource: normalized.discoverySource ?? "MAIN_FEED", searchQuery: normalized.searchQuery ?? null, searchQueries: normalized.searchQueries ?? [], foundInMainFeed: normalized.foundInMainFeed === true, firstSeenPhase: normalized.firstSeenPhase ?? "MAIN_FEED", mediaBinding: bindingSummary, mediaProvenance, imageExtractionVersion: 2, imageMirror: { ...imageMirror.stats, mode: dataFirstSearch ? "SEARCH_DATA_FIRST" : "FULL" }, imageWarnings: imageMirror.warnings, workflowStatus: workflowStatus(previousMetadata.workflowStatus) } }, { onConflict: "source,source_post_url" });
  if (metadata.error) throw new Error(`FACEBOOK_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  await assertFacebookPersistenceComplete(supabase, listingId, context.filter.id, sourceUrl, decision);
  console.info("FACEBOOK_MEDIA_BINDING_SUMMARY", { postId: externalId, ...bindingSummary, mirrored: imageMirror.images.length });
  console.info("FACEBOOK_PUBLICATION_DATE", { postId: externalId, source: normalized.publishedAt ? "FACEBOOK_CREATION_TIME" : previousSource.publishedAt ? "EXISTING_DATA" : "UNKNOWN", exact: Boolean(normalized.publishedAt), persisted: persistedPublishedAt });
  await recordFacebookGroupImport(context.groupName, listingCreated, score >= 85 || effective.sellerType === "private" && effective.condition === "renovation");
  const relevanceAccepted = normalized.imageAssessments?.filter((assessment) => assessment.relevance === "PROPERTY_IMAGE" && assessment.confidence >= 0.8).length ?? effective.images.length;
  const persistenceDiagnostics = facebookImagePersistenceDiagnostics({
    listingId,
    decision: manualRejected ? "REJECTED" : decision.bucket,
    lifecycleStatus: manualRejected ? "REJECTED" : decision.bucket === "MATCHED" ? "ACTIVE" : decision.bucket,
    existingListingFound: Boolean(existing),
    existingListingLifecycle: existingState.lifecycleStatus,
    imagePersistenceAttempted: !dataFirstSearch,
    storageUploadAttempted: dataFirstSearch ? 0 : imageMirror.stats.inputCount,
    storageUploadSuccess: dataFirstSearch ? 0 : imageMirror.stats.uploadedCount,
    storageUploadFailed: dataFirstSearch ? 0 : imageMirror.stats.failedCount,
    storageFailureReason: !dataFirstSearch && imageMirror.stats.failedCount > 0 ? "FACEBOOK_IMAGE_MIRROR_FAILED" : null,
    postId: externalId,
    creationTime: normalized.publishedAt ?? null,
    timestampSource: normalized.publishedAt ? "POST_PAGE_METADATA" as const : "UNKNOWN" as const,
    publishedAtCandidate: normalized.publishedAt ?? null,
    publishedAtPersistAttempted: true,
    publishedAtPersisted: !metadata.error,
    exactBoundCandidates: bindingSummary.exactBound,
    relevanceAccepted,
    mirrorAttempted: dataFirstSearch ? 0 : boundImages.length,
    mirroredCount: dataFirstSearch ? 0 : imageMirror.stats.uploadedCount,
    existingImages: existingState.images,
    finalListingImages: imageMirror.images,
    imageProvenance: facebookImageProvenanceDiagnostics(normalized.mediaCandidates ?? [], externalId, new Set(boundImages)),
    decisionReasons: manualRejected ? ["manual_rejected", ...decision.reasons] : decision.reasons,
    decisionUnknownFields: decision.unknownFields,
  });
  return { status: listingCreated ? "created" : "updated", listingId, extracted: effective, opportunityScore: score, listingCreated, listingUpdated, matched: decision.matches, matchCreated, imagesMirrored: imageMirror.stats.uploadedCount, priceDrops, warnings: [...imageMirror.warnings, ...facebookNoMatchWarnings(decision.matches, decision.reasons)], persistenceDiagnostics };
}

/**
 * A successful import is only complete when both source identity and the
 * canonical filter projection exist. This read-back deliberately reuses the
 * canonical RPC's projection contract; it never writes or reimplements it.
 * Missing state is a resumable failure, so the same captured post can retry.
 */
async function assertFacebookPersistenceComplete(
  supabase: ReturnType<typeof createFacebookWatcherAdminClient>,
  listingId: string,
  filterId: string,
  sourceUrl: string,
  decision: { bucket: "MATCHED" | "REVIEW" | "REJECTED" },
): Promise<void> {
  const [metadata, membership] = await Promise.all([
    supabase.from("listing_source_metadata").select("id").eq("source", "facebook").eq("source_post_url", sourceUrl).eq("listing_id", listingId).maybeSingle(),
    supabase.from("listing_filter_matches").select("is_current_match,match_reasons").eq("listing_id", listingId).eq("search_filter_id", filterId).maybeSingle(),
  ]);
  if (metadata.error) throw new Error(`FACEBOOK_METADATA_PERSIST_FAILED: ${metadata.error.message}`);
  if (!metadata.data?.id) throw new Error("FACEBOOK_METADATA_PERSIST_FAILED: persisted row not found");
  if (membership.error) throw new Error(`FACEBOOK_FILTER_RECONCILE_FAILED: ${membership.error.message}`);
  const matchReasons = Array.isArray(membership.data?.match_reasons) ? membership.data.match_reasons.filter((value): value is string => typeof value === "string") : [];
  const failure = facebookPersistenceFailure(decision.bucket, { metadataId: metadata.data?.id ? String(metadata.data.id) : null, membershipExists: Boolean(membership.data), isCurrentMatch: typeof membership.data?.is_current_match === "boolean" ? membership.data.is_current_match : undefined, matchReasons });
  if (failure) throw new Error(`${failure}: canonical persistence read-back incomplete`);
}

async function reconcileFacebookDecision(input: Parameters<typeof reconcileCanonicalListingDecision>[0]): Promise<Awaited<ReturnType<typeof reconcileCanonicalListingDecision>>> {
  try { return await reconcileCanonicalListingDecision(input); }
  catch (error) { throw mapFacebookPersistenceError(error); }
}

function mapFacebookPersistenceError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "canonical reconciliation failed";
  return message.startsWith("CANONICAL_RECONCILIATION_FAILED") ? new Error(`FACEBOOK_FILTER_RECONCILE_FAILED: ${message}`) : error instanceof Error ? error : new Error(message);
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

async function findExisting(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, item: FacebookProperty, sourceUrl: string, externalId: string, hash: string, activeListingsCache?: FacebookActiveListingCandidate[]): Promise<{id:string;source:string}|null> {
  const metadata = await supabase.from("listing_source_metadata").select("listing_id").eq("source", "facebook").eq("source_post_url", sourceUrl).maybeSingle();
  if (metadata.data?.listing_id) return { id: String(metadata.data.listing_id), source: "facebook" };
  const exact = await supabase.from("listings").select("id,source").or(`normalized_url.eq.${sourceUrl},and(source.eq.facebook,external_listing_id.eq.${externalId}),content_hash.eq.${hash}`).limit(1).maybeSingle();
  if (exact.data?.id) return { id: String(exact.data.id), source: String(exact.data.source) };
  const candidates = activeListingsCache ?? await fetchFacebookActiveListingCandidates();
  for (const row of candidates) {
    if (isLikelySameFacebookProperty(item, { price: row.price, area: row.area, district: row.district, address: row.address })) return { id: row.id, source: row.source };
  }
  return null;
}

async function applyFilters(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, listingId: string, item: FacebookProperty, pricePerSqm: number | null): Promise<Array<{ filterId: string; bucket: "MATCHED" | "REVIEW" | "REJECTED" }>> {
  const filters = await getActiveSearchFiltersForSource("facebook");
  const evaluated = filters.map((filter) => ({ filter, decision: evaluateCanonicalListingDecision({ price: item.price, area: item.area, pricePerSqm, rooms: item.rooms, floor: item.floor === null ? null : String(item.floor), city: item.city, district: item.district, title: item.title, locationText: [item.neighborhood,item.district,item.city].filter(Boolean).join(", "), buildingType: null, sellerType: item.sellerType, marketType: item.marketType, ownership: null }, filter) }));
  const currentBucket: "MATCHED" | "REVIEW" | "REJECTED" = evaluated.some(({ decision }) => decision.bucket === "MATCHED") ? "MATCHED" : evaluated.some(({ decision }) => decision.bucket === "REVIEW") ? "REVIEW" : "REJECTED";
  for (const { filter, decision } of evaluated) {
    await reconcileFacebookDecision({ supabase, listingId, filterId: filter.id, decision: { ...decision, reasons: decision.bucket === "MATCHED" ? ["collector_import", ...item.flags, ...decision.reasons] : decision.reasons }, lifecycleStatus: currentBucket === "MATCHED" ? "ACTIVE" : currentBucket, matchOrigin: "collector_import" });
  }
  return evaluated.map(({ filter, decision }) => ({ filterId: filter.id, bucket: decision.bucket }));
}

export async function listFacebookWatcher(): Promise<FacebookWatcherListing[]> {
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.from("listing_source_metadata").select("source_post_url,group_name,published_at,collected_at,metadata,listings(id,title,price,price_per_sqm,area,rooms,floor,district,city,address,description,original_url,images,status,source,flip_score,estimated_profit,first_seen_at,last_seen_at,created_at,building_type,ownership,lifecycle_status,archived_at)").eq("source", "facebook").order("collected_at", { ascending: false }).limit(500);
  if (error) throw new Error(`Nie udało się pobrać ofert Facebooka: ${error.message}`);
  const activeFilters = await getActiveSearchFiltersForSource("facebook");
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
    const priceQuality = parseFacebookPriceQuality(meta.priceQuality);
    const listingQuality = parseFacebookListingQuality(meta.listingQuality);
    const priceSuspect = isFacebookPriceSuspect(priceQuality?.status ?? "LIKELY");
    const searchIntent = parseEnum(meta.searchIntent, FACEBOOK_SEARCH_INTENTS);
    const propertyType = parseEnum(meta.propertyType, FACEBOOK_PROPERTY_TYPES);
    const availability = parseEnum(meta.availability, FACEBOOK_AVAILABILITY_STATES);
    const freshness = parseEnum(meta.freshness, FACEBOOK_FRESHNESS_STATES);
    const locationState = parseEnum(meta.locationState, FACEBOOK_LOCATION_STATES);
    const contentQuality = parseEnum(meta.contentQuality, FACEBOOK_CONTENT_QUALITY_GRADES);
    const lifecycleStatus = str(listing.lifecycle_status);
    const current = classifyFacebookRestore({ price: num(listing.price), area: num(listing.area), pricePerSqm: num(listing.price_per_sqm), rooms: num(listing.rooms), floor: typeof listing.floor === "string" ? listing.floor : listing.floor === null || listing.floor === undefined ? null : String(listing.floor), city: str(listing.city), district: str(listing.district), title: str(listing.title), locationText: [str(listing.address), str(listing.district), str(listing.city)].filter(Boolean).join(", ") || null, buildingType: str(listing.building_type), sellerType, ownership: str(listing.ownership), marketType: null }, activeFilters);
    const currentReasons = current.decision ? [...current.decision.reasons, ...(current.bucket === "REVIEW" ? ["review", ...current.decision.unknownFields.map((field) => `unknown_${field}`)] : [])] : ["no_active_facebook_filter_match"];
    const historical = lifecycleStatus === "ARCHIVED" || lifecycleStatus === "STALE";
    return [{ listingId, title: String(listing.title ?? "Oferta z Facebooka"), city: str(listing.city), district: str(listing.district), neighborhood: str(meta.neighborhood), street: str(listing.address), price: num(listing.price), pricePerM2: num(listing.price_per_sqm), pricePerSqm: num(listing.price_per_sqm), area: num(listing.area), rooms: num(listing.rooms), floor: num(listing.floor), totalFloors: null, marketType: null, sellerType, condition, description: str(listing.description), originalUrl: facebookUrl?.startsWith("http") ? facebookUrl : null, images: Array.isArray(listing.images) ? listing.images.filter((x):x is string=>typeof x==="string") : [], confidence: num(meta.confidence) ?? 0, flags, status: String(listing.status), groupName: str(row.group_name), workflowStatus: workflowStatus(meta.workflowStatus), readAt, importedAt, publishedAt, opportunityScore: score, flipScore, potentialProfit: num(listing.estimated_profit), isNew: !readAt && Date.now() - Date.parse(importedAt) <= 86_400_000, highPriority: (score >= 85 || flipScore >= 85) && !priceSuspect || sellerType === "private" && condition === "renovation", crossSourceMatch: meta.crossSourceMatch === true, crossSourceLinks: meta.crossSourceMatch === true && source !== "facebook" && sourceUrl ? [{ source, url: sourceUrl }] : [], source, lifecycleStatus, archivedAt: str(listing.archived_at), priceQuality, listingQuality, searchIntent, propertyType, availability, freshness, locationState, contentQuality, currentFilterDecision: current.bucket, currentFilterReasons: currentReasons, currentFilterMissingFields: current.decision?.unknownFields ?? [], finderStatus: historical ? "HISTORICAL" : current.bucket, finderVisible: !historical && (current.bucket === "MATCHED" || current.bucket === "REVIEW") && String(listing.status) === "active" }];
  });
}

/** Read-only maintenance view. It never mutates an orphan while listing it. */
export async function listFacebookOrphans(): Promise<FacebookOrphanDiagnostic[]> {
  const supabase = createFacebookWatcherAdminClient();
  const filters = await getActiveSearchFiltersForSource("facebook");
  const listings = await supabase.from("listings").select("id,external_listing_id,original_url").eq("source", "facebook").eq("status", "active").limit(500);
  if (listings.error) throw new Error(`FACEBOOK_ORPHAN_LIST_FAILED: ${listings.error.message}`);
  const rows = (listings.data ?? []) as Row[];
  const ids = rows.map((row) => String(row.id)).filter(Boolean);
  if (ids.length === 0) return [];
  const [metadata, memberships] = await Promise.all([
    supabase.from("listing_source_metadata").select("listing_id").eq("source", "facebook").in("listing_id", ids),
    supabase.from("listing_filter_matches").select("listing_id,search_filter_id,match_reasons,is_current_match").in("listing_id", ids),
  ]);
  if (metadata.error) throw new Error(`FACEBOOK_ORPHAN_METADATA_READ_FAILED: ${metadata.error.message}`);
  if (memberships.error) throw new Error(`FACEBOOK_ORPHAN_MEMBERSHIP_READ_FAILED: ${memberships.error.message}`);
  const metadataIds = new Set((metadata.data ?? []).map((row) => String(row.listing_id)));
  const membershipByListing = new Map<string, Set<string>>();
  for (const row of memberships.data ?? []) {
    const listingId = String(row.listing_id); const filterId = String(row.search_filter_id);
    const reasons = Array.isArray(row.match_reasons) ? row.match_reasons.filter((value): value is string => typeof value === "string") : [];
    if (!filters.some((filter) => filter.id === filterId) || (!row.is_current_match && !reasons.some((reason) => reason === "review" || reason.startsWith("unknown_")))) continue;
    const set = membershipByListing.get(listingId) ?? new Set<string>(); set.add(filterId); membershipByListing.set(listingId, set);
  }
  return rows.flatMap((row) => {
    const listingId = String(row.id); const externalId = str(row.external_listing_id); const originalUrl = str(row.original_url);
    if (!externalId || !originalUrl) return [];
    const missingFilterIds = filters.map((filter) => filter.id).filter((filterId) => !membershipByListing.get(listingId)?.has(filterId));
    const candidate = orphanDiagnostic({ listingId, externalListingId: externalId, originalUrl, hasTrustedIdentity: /^https:\/\/(?:www\.)?facebook\.com\//i.test(originalUrl), hasSourceMetadata: metadataIds.has(listingId), missingFilterIds });
    return isFacebookOrphan(candidate) ? [candidate] : [];
  });
}

/**
 * Replays the normal ingestion path from immutable collector evidence. No
 * direct table patching is performed; metadata and membership are repaired by
 * importFacebookWatcher -> persistListing -> the existing canonical RPC.
 */
export async function repairFacebookOrphanFromCollectorEvidence(listingId: string): Promise<{ listingId: string; repairedFilters: string[] }> {
  const supabase = createFacebookWatcherAdminClient();
  const listing = await supabase.from("listings").select("id,source,external_listing_id").eq("id", listingId).eq("source", "facebook").maybeSingle();
  if (listing.error) throw new Error(`FACEBOOK_ORPHAN_REPAIR_LISTING_READ_FAILED: ${listing.error.message}`);
  const externalId = str(listing.data?.external_listing_id);
  if (!externalId) throw new Error("FACEBOOK_ORPHAN_SOURCE_IDENTITY_MISSING");
  const batches = await supabase.from("collector_scan_batches").select("scan_id,source_id,source_url,payload").eq("source_type", "GROUP").order("received_at", { ascending: false }).limit(100);
  if (batches.error) throw new Error(`FACEBOOK_ORPHAN_EVIDENCE_READ_FAILED: ${batches.error.message}`);
  const evidence = (batches.data ?? []).map((batch) => ({ batch, payload: record(batch.payload) })).find(({ payload }) => Array.isArray(payload?.posts) && payload.posts.some((post: unknown) => record(post)?.postId === externalId));
  if (!evidence) throw new Error("FACEBOOK_ORPHAN_SOURCE_EVIDENCE_MISSING");
  const batch = evidence.batch as Row; const payload = evidence.payload!;
  const post = (payload.posts as unknown[]).map(record).find((value): value is Row => value?.postId === externalId);
  if (!post) throw new Error("FACEBOOK_ORPHAN_SOURCE_EVIDENCE_MISSING");
  const filters = await getActiveSearchFiltersForSource("facebook");
  if (filters.length === 0) throw new Error("FACEBOOK_ORPHAN_NO_ACTIVE_FILTER");
  const sourceScans = await supabase.from("source_scans").select("id,search_filter_id").eq("scan_run_id", String(batch.scan_id)).eq("source", "facebook");
  if (sourceScans.error) throw new Error(`FACEBOOK_ORPHAN_SOURCE_SCAN_READ_FAILED: ${sourceScans.error.message}`);
  const media = Array.isArray(post.media) ? post.media.map(record).flatMap((item) => item && typeof item.url === "string" ? [item.url] : []) : [];
  const input: FacebookListingInput = { url: str(post.permalink) ?? undefined, postText: str(post.text) ?? undefined, authorName: str(post.author) ?? undefined, groupName: str(batch.source_id) ?? undefined, publishedAt: str(post.publishedAt) ?? undefined, images: media, discoverySource: post.discoverySource === "SEARCH" ? "SEARCH" : "MAIN_FEED", foundInMainFeed: post.foundInMainFeed === true, firstSeenPhase: post.firstSeenPhase === "SEARCH" ? "SEARCH" : "MAIN_FEED" };
  const repairedFilters: string[] = [];
  for (const filter of filters) {
    const sourceScanId = String((sourceScans.data ?? []).find((row) => String(row.search_filter_id) === filter.id)?.id ?? (sourceScans.data ?? [])[0]?.id ?? "");
    if (!sourceScanId) continue;
    const result = await importFacebookWatcher(input, { filter, sourceScanId, groupId: String(batch.source_id), groupName: String(batch.source_id), groupUrl: String(batch.source_url), postId: externalId, checkedAt: new Date().toISOString(), preserveExistingImagesOnEmptyInput: true, imageMode: "SEARCH_DATA_FIRST" });
    if (result.listingId !== listingId) throw new Error("FACEBOOK_ORPHAN_REPAIR_IDENTITY_MISMATCH");
    repairedFilters.push(filter.id);
  }
  if (repairedFilters.length === 0) throw new Error("FACEBOOK_ORPHAN_REPAIR_NO_SOURCE_SCAN");
  return { listingId, repairedFilters };
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

export async function restoreFacebookWatcherListing(listingId: string): Promise<{ restored: boolean; bucket: "MATCHED" | "REVIEW" | "REJECTED"; lifecycleStatus: string; reasons: string[]; unknownFields: string[] }> {
  const supabase = createFacebookWatcherAdminClient();
  const listingResult = await supabase.from("listings").select("id,source,price,area,price_per_sqm,rooms,floor,city,district,address,title,building_type,ownership,description,lifecycle_status,manual_decision").eq("id", listingId).maybeSingle();
  const listing = listingResult.data as Row | null;
  if (listingResult.error || !listing || listing.source !== "facebook") throw new Error("FACEBOOK_RESTORE_LISTING_NOT_FOUND");
  const sourceMetadata = await supabase.from("listing_source_metadata").select("id").eq("listing_id", listingId).eq("source", "facebook").limit(1);
  if (sourceMetadata.error || !sourceMetadata.data?.length) throw new Error("FACEBOOK_RESTORE_SOURCE_METADATA_MISSING");
  if (listing.lifecycle_status !== "ARCHIVED" && listing.lifecycle_status !== "STALE") throw new Error("FACEBOOK_RESTORE_NOT_ARCHIVED");
  if (listing.manual_decision === "REJECTED") return { restored: false, bucket: "REJECTED", lifecycleStatus: String(listing.lifecycle_status), reasons: ["manual_rejected"], unknownFields: [] };
  const filters = await getActiveSearchFiltersForSource("facebook");
  const outcome = classifyFacebookRestore({ price: num(listing.price), area: num(listing.area), pricePerSqm: num(listing.price_per_sqm), rooms: num(listing.rooms), floor: typeof listing.floor === "string" ? listing.floor : listing.floor === null || listing.floor === undefined ? null : String(listing.floor), city: str(listing.city), district: str(listing.district), title: str(listing.title), locationText: [str(listing.address), str(listing.district), str(listing.city)].filter(Boolean).join(", ") || null, buildingType: str(listing.building_type), sellerType: null, ownership: str(listing.ownership), marketType: null }, filters);
  if (outcome.bucket === "REJECTED" || !outcome.filter || !outcome.decision) return { restored: false, bucket: "REJECTED", lifecycleStatus: String(listing.lifecycle_status), reasons: outcome.decision?.reasons.length ? outcome.decision.reasons : ["no_active_facebook_filter_match"], unknownFields: [] };
  const now = new Date().toISOString();
  const reasons = outcome.bucket === "REVIEW" ? ["review", ...outcome.decision.unknownFields.map((field) => `unknown_${field}`)] : ["facebook_restore"];
  const reconciled = await reconcileCanonicalListingDecision({
    supabase,
    listingId,
    filterId: outcome.filter.id,
    decision: { bucket: outcome.bucket, reasons, missingFields: outcome.decision.unknownFields, hardRejectReasons: outcome.decision.bucket === "REJECTED" ? outcome.decision.reasons : [] },
    lifecycleStatus: outcome.bucket === "MATCHED" ? "ACTIVE" : "REVIEW",
    matchOrigin: "filter_recalculation",
    matchedAt: now,
  });
  return { restored: true, bucket: reconciled.bucket, lifecycleStatus: reconciled.lifecycleStatus, reasons: reconciled.matchReasons, unknownFields: outcome.decision.unknownFields };
}
function workflowStatus(value: unknown): FacebookWorkflowStatus { return FACEBOOK_WORKFLOW_STATUSES.includes(value as FacebookWorkflowStatus) ? value as FacebookWorkflowStatus : "new"; }
function facebookSellerType(value: unknown, flags: string[]): FacebookWatcherListing["sellerType"] { if (value === "private" || value === "agency") return value; return flags.some((flag)=>/bezpośred|właściciel/i.test(flag)) ? "private" : null; }
function facebookCondition(value: unknown, flags: string[]): FacebookWatcherListing["condition"] { if (value === "renovation" || value === "ready") return value; return flags.some((flag)=>/remont/i.test(flag)) ? "renovation" : null; }
const record=(v:unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const str=(v:unknown)=>typeof v==="string"?v:null; const num=(v:unknown)=>typeof v==="number"?v:typeof v==="string"&&v!==""?Number(v):null;
function parseFacebookPriceQuality(value: unknown): FacebookPriceQuality | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Row;
  const status = row.status;
  if (typeof status !== "string" || !FACEBOOK_PRICE_STATUSES.includes(status as FacebookPriceStatus)) return undefined;
  const category = typeof row.category === "string" && FACEBOOK_PRICE_CATEGORIES.includes(row.category as FacebookPriceCategory) ? row.category as FacebookPriceCategory : "UNKNOWN_AMOUNT";
  const source = typeof row.source === "string" && FACEBOOK_PRICE_SOURCES.includes(row.source as FacebookPriceSource) ? row.source as FacebookPriceSource : "OTHER";
  return {
    status: status as FacebookPriceStatus, category, source,
    rawPriceText: str(row.rawPriceText), priceContext: str(row.priceContext),
    reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes.filter((x): x is string => typeof x === "string") : [],
    conflict: row.conflict === true,
    candidates: Array.isArray(row.candidates) ? row.candidates as FacebookPriceQuality["candidates"] : [],
  };
}
function parseFacebookListingQuality(value: unknown): FacebookListingQualityGrade | undefined {
  return value === "COMPLETE" || value === "USABLE" || value === "NEEDS_REVIEW" || value === "INVALID" ? value : undefined;
}
function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}
