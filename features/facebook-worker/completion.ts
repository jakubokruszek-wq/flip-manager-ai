import { FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES, FACEBOOK_CONFIDENCE_FIELDS, FACEBOOK_IMAGE_RELEVANCE, FACEBOOK_LISTING_INTENTS, FACEBOOK_MEDIA_BINDING_PROVENANCE, type FacebookAgeCacheEntry, type FacebookCompletion, type FacebookFieldConfidence, type FacebookGroupSnapshot, type FacebookImageAssessment, type FacebookMediaCandidate, type FacebookPerformanceMetrics, type FacebookPostSnapshot, type FacebookSkipReasonCode, type FacebookVisionExtraction, type FacebookVisionUsage } from "./types.ts";
import { OPENAI_PRICING_VERSION } from "./openai-pricing.ts";

const FACEBOOK_HOST = /(^|\.)facebook\.com$/i;
const MAX_POSTS = 20;
const MAX_TEXT = 2_000;
const MAX_IMAGES = 5;
const FACEBOOK_SKIP_REASON_CODES: FacebookSkipReasonCode[] = ["NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS", "FACEBOOK_BUY_REQUEST", "FACEBOOK_RENT_REQUEST", "FACEBOOK_SERVICE_POST", "FACEBOOK_NON_SALE_POST", "FACEBOOK_INTENT_UNKNOWN"];

export function assertFacebookGroupUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !FACEBOOK_HOST.test(url.hostname) || !/^\/groups\/[^/]+/i.test(url.pathname)) throw new Error("FACEBOOK_GROUP_URL_NOT_ALLOWED");
  return url;
}

export function assertFacebookPermalink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !FACEBOOK_HOST.test(url.hostname)) throw new Error("FACEBOOK_POST_URL_NOT_ALLOWED");
  return url.toString();
}

export function parseFacebookGroupSnapshot(value: unknown): FacebookGroupSnapshot {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("FACEBOOK_GROUP_REQUIRED");
  const row = requireRow(value[0]);
  return { id: requiredString(row.id, "GROUP_ID", 200), name: requiredString(row.name, "GROUP_NAME", 200), url: assertFacebookGroupUrl(requiredString(row.url, "GROUP_URL", 2_000)).toString() };
}

export function assertFacebookPostsBelongToGroup(posts: Array<{ groupId: string }>, group: FacebookGroupSnapshot): void {
  if (posts.some((post) => post.groupId !== group.id)) throw new Error("FACEBOOK_GROUP_MISMATCH");
}

export function parseFacebookCompletionPayload(value: unknown): FacebookCompletion {
  const row = requireRow(value);
  if (!Array.isArray(row.posts) || row.posts.length > MAX_POSTS) throw new Error("INVALID_FACEBOOK_POSTS");
  return {
    jobId: requiredString(row.jobId, "JOB_ID", 100),
    leaseToken: requiredString(row.leaseToken, "LEASE_TOKEN", 100),
    workerId: requiredString(row.workerId, "WORKER_ID", 100),
    posts: row.posts.map(parsePost),
    warnings: stringArray(row.warnings, 20, 500),
    durationMs: nonnegativeInteger(row.durationMs),
    performance: parsePerformance(row.performance),
    ageCache: parseAgeCache(row.ageCache),
  };
}

function parsePost(value: unknown): FacebookPostSnapshot {
  const row = requireRow(value);
  return {
    postId: nullableString(row.postId, 300),
    groupId: requiredString(row.groupId, "GROUP_ID", 200),
    permalink: row.permalink === null ? null : assertFacebookPermalink(requiredString(row.permalink, "PERMALINK", 2_000)),
    authoritativePostText: nullableString(row.authoritativePostText, MAX_TEXT),
    authoritativePostTextSource: FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES.includes(row.authoritativePostTextSource as never) ? row.authoritativePostTextSource as FacebookPostSnapshot["authoritativePostTextSource"] : "NONE",
    text: typeof row.text === "string" ? row.text.slice(0, MAX_TEXT) : "",
    imageUrls: stringArray(row.imageUrls, MAX_IMAGES, 2_000).map(assertHttpsUrl),
    mediaCandidates: parseMediaCandidates(row.mediaCandidates),
    publishedAt: nullableIsoDate(row.publishedAt),
    vision: parseVision(row.vision),
    cacheHit: parseCacheHit(row.cacheHit),
  };
}

function parseMediaCandidates(value: unknown): FacebookMediaCandidate[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error("INVALID_FACEBOOK_MEDIA_CANDIDATES");
  return value.map((item) => {
    const row = requireRow(item);
    const provenance = FACEBOOK_MEDIA_BINDING_PROVENANCE.includes(row.bindingProvenance as never) ? row.bindingProvenance as FacebookMediaCandidate["bindingProvenance"] : "AMBIGUOUS";
    const classification = FACEBOOK_IMAGE_RELEVANCE.includes(row.classification as never) ? row.classification as FacebookMediaCandidate["classification"] : "UNKNOWN";
    return {
      url: assertHttpsUrl(requiredString(row.url, "MEDIA_URL", 2_000)),
      expectedPostId: requiredString(row.expectedPostId, "EXPECTED_POST_ID", 300),
      boundPostId: nullableString(row.boundPostId, 300),
      bindingConfidence: boundedConfidence(row.bindingConfidence),
      bindingProvenance: provenance,
      rootStoryUnique: row.rootStoryUnique === true,
      foreignPostIdsDetected: stringArray(row.foreignPostIdsDetected, 20, 300),
      classification,
      classificationConfidence: row.classificationConfidence === null || row.classificationConfidence === undefined ? null : boundedConfidence(row.classificationConfidence),
    };
  });
}

function parseCacheHit(value: unknown): FacebookPostSnapshot["cacheHit"] {
  if (value === null || value === undefined) return null;
  const row = requireRow(value);
  const scope = row.scope === "RUN" || row.scope === "RECENT" ? row.scope : null;
  if (!scope) throw new Error("INVALID_FACEBOOK_CACHE_HIT");
  const outcome = row.outcome === "DETERMINISTIC_SKIP" ? "DETERMINISTIC_SKIP" : "SELL_PERSISTED";
  const listingId = outcome === "SELL_PERSISTED" ? requiredString(row.listingId, "LISTING_ID", 100) : null;
  const reasonCode = FACEBOOK_SKIP_REASON_CODES.includes(row.reasonCode as FacebookSkipReasonCode) ? row.reasonCode as FacebookSkipReasonCode : undefined;
  const listingIntent = FACEBOOK_LISTING_INTENTS.includes(row.listingIntent as never) ? row.listingIntent as FacebookVisionExtraction["listingIntent"] : undefined;
  const intentSource = row.intentSource === "DETERMINISTIC_BUY" || row.intentSource === "DETERMINISTIC_SELL" ? row.intentSource : undefined;
  return { sourceJobId: requiredString(row.sourceJobId, "SOURCE_JOB_ID", 100), listingId, analyzedAt: requiredIsoDate(row.analyzedAt), scope, outcome, reasonCode, listingIntent, intentSource };
}

function parsePerformance(value: unknown): FacebookPerformanceMetrics {
  if (value === null || value === undefined) return { postsDiscovered: 0, discoveredPostIds: [], duplicatePostIdsSkipped: 0, pageOpens: 0, visionCalls: 0, visionCacheHits: 0, knownPostSkips: 0, discoveryScrolls: 0, feedAgeHits: 0, ageCacheHits: 0, agePageFallbacks: 0, oldPostsSkippedBeforePageOpen: 0, earlyStopOldBoundaryCount: 0, feedTimestampCandidates: 0, exactBoundFeedTimestamps: 0, rejectedAmbiguousFeedTimestamps: 0, feedAgeHitRate: 0, duplicatePostIdsAcrossGroups: 0, fullExtractionCacheHits: 0, fullExtractionCacheMisses: 0, dedicatedPageReuses: 0, duplicateVisionCallsAvoided: 0, duplicatePageOpensAvoided: 0 };
  const row = requireRow(value);
  return {
    postsDiscovered: nonnegativeInteger(row.postsDiscovered),
    discoveredPostIds: stringArray(row.discoveredPostIds, 50, 300),
    duplicatePostIdsSkipped: nonnegativeInteger(row.duplicatePostIdsSkipped),
    pageOpens: nonnegativeInteger(row.pageOpens),
    visionCalls: nonnegativeInteger(row.visionCalls),
    visionCacheHits: nonnegativeInteger(row.visionCacheHits),
    knownPostSkips: nonnegativeInteger(row.knownPostSkips),
    discoveryScrolls: nonnegativeInteger(row.discoveryScrolls),
    feedAgeHits: optionalNonnegativeInteger(row.feedAgeHits),
    ageCacheHits: optionalNonnegativeInteger(row.ageCacheHits),
    agePageFallbacks: optionalNonnegativeInteger(row.agePageFallbacks),
    oldPostsSkippedBeforePageOpen: optionalNonnegativeInteger(row.oldPostsSkippedBeforePageOpen),
    earlyStopOldBoundaryCount: optionalNonnegativeInteger(row.earlyStopOldBoundaryCount),
    feedTimestampCandidates: optionalNonnegativeInteger(row.feedTimestampCandidates),
    exactBoundFeedTimestamps: optionalNonnegativeInteger(row.exactBoundFeedTimestamps),
    rejectedAmbiguousFeedTimestamps: optionalNonnegativeInteger(row.rejectedAmbiguousFeedTimestamps),
    feedAgeHitRate: optionalRate(row.feedAgeHitRate),
    duplicatePostIdsAcrossGroups: optionalNonnegativeInteger(row.duplicatePostIdsAcrossGroups),
    fullExtractionCacheHits: optionalNonnegativeInteger(row.fullExtractionCacheHits),
    fullExtractionCacheMisses: optionalNonnegativeInteger(row.fullExtractionCacheMisses),
    dedicatedPageReuses: optionalNonnegativeInteger(row.dedicatedPageReuses),
    duplicateVisionCallsAvoided: optionalNonnegativeInteger(row.duplicateVisionCallsAvoided),
    duplicatePageOpensAvoided: optionalNonnegativeInteger(row.duplicatePageOpensAvoided),
  };
}

function parseAgeCache(value: unknown): FacebookAgeCacheEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error("INVALID_FACEBOOK_AGE_CACHE");
  return value.map((item) => {
    const row = requireRow(item);
    const decision = row.decision === "FRESH" || row.decision === "TOO_OLD" || row.decision === "UNKNOWN" ? row.decision : null;
    const source = row.source === "FEED" || row.source === "POST_PAGE_METADATA" || row.source === "POST_PAGE" ? row.source : null;
    if (!decision || !source) throw new Error("INVALID_FACEBOOK_AGE_CACHE");
    return { postId: requiredString(row.postId, "POST_ID", 300), checkedAt: requiredIsoDate(row.checkedAt), publishedAt: nullableIsoDate(row.publishedAt), decision, source };
  });
}

function parseVision(value: unknown): FacebookVisionExtraction | null {
  if (value === null || value === undefined) return null;
  const row = requireRow(value);
  if (typeof row.isProperty !== "boolean") throw new Error("INVALID_FACEBOOK_VISION");
  return { isProperty: row.isProperty === true, listingIntent: FACEBOOK_LISTING_INTENTS.includes(row.listingIntent as never) ? row.listingIntent as FacebookVisionExtraction["listingIntent"] : "UNKNOWN", intentConfidence: boundedConfidence(row.intentConfidence), title: nullableString(row.title, 500), description: nullableString(row.description, 2_000), visibleText: nullableString(row.visibleText, 2_000), city: nullableString(row.city, 200), district: nullableString(row.district, 200), neighborhood: nullableString(row.neighborhood, 200), street: nullableString(row.street, 300), price: nullableNumber(row.price), area: nullableNumber(row.area), rooms: nullableNumber(row.rooms), floor: nullableNumber(row.floor), totalFloors: nullableNumber(row.totalFloors), condition: row.condition === "renovation" || row.condition === "ready" ? row.condition : null, sellerType: row.sellerType === "private" || row.sellerType === "agency" ? row.sellerType : null, confidence: boundedConfidence(row.confidence), fieldConfidence: parseFieldConfidence(row.fieldConfidence), imageAssessments: parseImageAssessments(row.imageAssessments), usage: parseVisionUsage(row.usage) };
}

function parseVisionUsage(value: unknown): FacebookVisionUsage {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!row) return { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null, model: "unknown", requestId: null, estimatedCostUsd: null, pricingSourceModel: null, pricingVersion: OPENAI_PRICING_VERSION, dataQuality: "UNAVAILABLE", diagnosticsReason: "OPENAI_USAGE_UNAVAILABLE" };
  const dataQuality = row.dataQuality === "EXACT" || row.dataQuality === "PARTIAL" || row.dataQuality === "UNAVAILABLE" ? row.dataQuality : "UNAVAILABLE";
  return {
    inputTokens: nullableToken(row.inputTokens), outputTokens: nullableToken(row.outputTokens), totalTokens: nullableToken(row.totalTokens),
    cachedInputTokens: nullableToken(row.cachedInputTokens), reasoningTokens: nullableToken(row.reasoningTokens),
    model: requiredString(row.model, "MODEL", 200), requestId: nullableString(row.requestId, 300),
    estimatedCostUsd: nullableNonnegativeNumber(row.estimatedCostUsd), pricingSourceModel: nullableString(row.pricingSourceModel, 200),
    pricingVersion: requiredString(row.pricingVersion, "PRICING_VERSION", 100), dataQuality,
    diagnosticsReason: row.diagnosticsReason === "OPENAI_USAGE_UNAVAILABLE" ? "OPENAI_USAGE_UNAVAILABLE" : null,
  };
}

function parseImageAssessments(value: unknown): FacebookImageAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_IMAGES).flatMap((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!row || !Number.isInteger(row.imageIndex) || !FACEBOOK_IMAGE_RELEVANCE.includes(row.relevance as never)) return [];
    return [{ imageIndex: row.imageIndex as number, relevance: row.relevance as FacebookImageAssessment["relevance"], confidence: boundedConfidence(row.confidence) }];
  });
}

function parseFieldConfidence(value: unknown): FacebookFieldConfidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(FACEBOOK_CONFIDENCE_FIELDS.map((field) => [field, boundedConfidence(row[field])])) as FacebookFieldConfidence;
}

function assertHttpsUrl(value: string): string { const url = new URL(value); if (url.protocol !== "https:") throw new Error("INVALID_IMAGE_URL"); return url.toString(); }
function requireRow(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD"); return value as Record<string, unknown>; }
function requiredString(value: unknown, field: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`INVALID_${field}`); return value.trim(); }
function nullableString(value: unknown, max: number): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function nullableIsoDate(value: unknown): string | null { if (value === null || value === undefined || value === "") return null; if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("INVALID_PUBLISHED_AT"); return new Date(value).toISOString(); }
function requiredIsoDate(value: unknown): string { const parsed = nullableIsoDate(value); if (!parsed) throw new Error("INVALID_DATE"); return parsed; }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
function optionalNonnegativeInteger(value: unknown): number { return value === null || value === undefined ? 0 : nonnegativeInteger(value); }
function optionalRate(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("INVALID_RATE");
  return value;
}
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function nullableNonnegativeNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function nullableToken(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function boundedConfidence(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function stringArray(value: unknown, maxItems: number, maxLength: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > maxLength)) throw new Error("INVALID_STRING_ARRAY"); return value.map(String); }
