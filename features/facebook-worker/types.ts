export const FACEBOOK_FAILURE_CODES = [
  "FACEBOOK_LOGIN_REQUIRED",
  "FACEBOOK_SESSION_EXPIRED",
  "FACEBOOK_CHALLENGE",
  "FACEBOOK_ACCESS_DENIED",
  "FACEBOOK_GROUP_UNAVAILABLE",
] as const;

export type FacebookFailureCode = (typeof FACEBOOK_FAILURE_CODES)[number];
export type FacebookJobStatus = "queued" | "running" | "completed" | "failed";

export type FacebookGroupSnapshot = {
  id: string;
  name: string;
  url: string;
};

export type FacebookPostSnapshot = {
  postId: string | null;
  groupId: string;
  permalink: string | null;
  authoritativePostText?: string | null;
  authoritativePostTextSource?: FacebookAuthoritativePostTextSource;
  authoritativePostTextProvenance?: FacebookAuthoritativePostTextProvenance;
  text: string;
  imageUrls: string[];
  mediaCandidates?: FacebookMediaCandidate[];
  publishedAt: string | null;
  vision?: FacebookVisionExtraction | null;
  cacheHit?: FacebookPostCacheHit | null;
};

export const FACEBOOK_MEDIA_BINDING_PROVENANCE = ["EXACT_ROOT_STORY", "EXACT_POST_METADATA", "DEDICATED_POST_VIEWER", "AMBIGUOUS"] as const;
export type FacebookMediaBindingProvenance = (typeof FACEBOOK_MEDIA_BINDING_PROVENANCE)[number];
export type FacebookMediaCandidate = {
  url: string;
  expectedPostId: string;
  /** Canonical post id of the one exact DOM story root that contained this media. */
  storyRootPostId?: string | null;
  boundPostId: string | null;
  bindingConfidence: number;
  bindingProvenance: FacebookMediaBindingProvenance;
  rootStoryUnique: boolean;
  foreignPostIdsDetected: string[];
  classification: FacebookImageRelevance;
  classificationConfidence: number | null;
  /** Explicit structured metadata binding can substitute for a DOM story root. */
  structuredPostMediaProvenance?: boolean;
  /** Intrinsic media dimensions when the browser could read them. */
  intrinsicWidth?: number | null;
  intrinsicHeight?: number | null;
};

export type FacebookImageRevalidationTarget = {
  listingId: string;
  postId: string;
  permalink: string;
  currentImages: string[];
};

export type FacebookImageRevalidationCandidate = Pick<FacebookMediaCandidate,
  "url" | "expectedPostId" | "storyRootPostId" | "boundPostId" | "bindingConfidence" |
  "bindingProvenance" | "rootStoryUnique" | "foreignPostIdsDetected" |
  "classification" | "classificationConfidence" | "structuredPostMediaProvenance">
  & { contentHash?: string | null; storageUrl?: string | null };

export type FacebookImageRevalidationResult = {
  listingId: string;
  postId: string;
  status: "SUCCESS" | "FAILED" | "UNKNOWN" | "DRY_RUN";
  beforeCount: number;
  afterCount: number;
  candidates: number;
  verifiedImages: number;
  rejectedImages: number;
  rejectionReasons: string[];
  visionCalls: number;
  pageOpens: number;
  durationMs: number;
  wouldReplaceGallery: boolean;
};

export type FacebookPostCacheHit = {
  sourceJobId: string;
  listingId: string | null;
  analyzedAt: string;
  scope: "RUN" | "RECENT";
  outcome: "SELL_PERSISTED" | "DETERMINISTIC_SKIP";
  reasonCode?: FacebookSkipReasonCode;
  listingIntent?: FacebookListingIntent;
  intentSource?: FacebookIntentSource;
};

export type FacebookPostCacheEntry = {
  postId: string;
  listingId: string | null;
  analyzedAt: string;
  publishedAt: string;
  outcome: "SELL_PERSISTED" | "DETERMINISTIC_SKIP";
  reasonCode?: FacebookSkipReasonCode;
  listingIntent?: FacebookListingIntent;
  intentSource?: FacebookIntentSource;
};

export type FacebookAgeDecision = "FRESH" | "TOO_OLD" | "UNKNOWN";
export type FacebookAgeSource = "FEED" | "POST_PAGE_METADATA" | "POST_PAGE";

export type FacebookAgeCacheEntry = {
  postId: string;
  checkedAt: string;
  publishedAt: string | null;
  decision: FacebookAgeDecision;
  source: FacebookAgeSource;
};

export type FacebookAgeCacheHit = FacebookAgeCacheEntry & {
  sourceJobId: string;
  scope: "RUN" | "RECENT";
};

export type FacebookPerformanceMetrics = {
  postsDiscovered: number;
  discoveredPostIds: string[];
  duplicatePostIdsSkipped: number;
  pageOpens: number;
  visionCalls: number;
  visionCacheHits: number;
  knownPostSkips: number;
  discoveryScrolls: number;
  feedAgeHits: number;
  ageCacheHits: number;
  agePageFallbacks: number;
  oldPostsSkippedBeforePageOpen: number;
  earlyStopOldBoundaryCount: number;
  feedTimestampCandidates: number;
  exactBoundFeedTimestamps: number;
  rejectedAmbiguousFeedTimestamps: number;
  feedAgeHitRate: number;
  duplicatePostIdsAcrossGroups: number;
  fullExtractionCacheHits: number;
  fullExtractionCacheMisses: number;
  dedicatedPageReuses: number;
  duplicateVisionCallsAvoided: number;
  duplicatePageOpensAvoided: number;
  postTimings?: FacebookPostPerformanceTiming[];
  totalNavigationMs?: number;
  totalVisionMs?: number;
  totalAgeFallbackMs?: number;
  cacheHitCount?: number;
  cacheMissCount?: number;
};

export type FacebookPostPerformanceTiming = {
  postId: string;
  feedDiscoveryMs: number;
  ageDetectionMs: number;
  ageFallbackMs: number;
  dedicatedPageNavigationMs: number;
  extractionMs: number;
  visionMs: number;
  persistenceMs: number;
  completionMs: number;
  totalMs: number;
  cacheHit: boolean;
};

export const FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES = ["POST_PAGE_METADATA", "POST_REGION_DOM", "SHARED_POST_FALLBACK", "CONFLICT", "NONE"] as const;
export type FacebookAuthoritativePostTextSource = (typeof FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES)[number];

export const FACEBOOK_AUTHORITATIVE_POST_TEXT_PROVENANCE = ["ROOT_AUTHOR_MESSAGE", "SHARED_CONTENT_ONLY", "AMBIGUOUS_COMPOSITE", "NONE"] as const;
export type FacebookAuthoritativePostTextProvenance = (typeof FACEBOOK_AUTHORITATIVE_POST_TEXT_PROVENANCE)[number];

export const FACEBOOK_LISTING_INTENTS = [
  "SELL_PROPERTY", "BUY_PROPERTY", "RENT_OFFER", "RENT_WANTED", "SERVICE", "OTHER", "UNKNOWN",
] as const;
export type FacebookListingIntent = (typeof FACEBOOK_LISTING_INTENTS)[number];

export const FACEBOOK_INTENT_SOURCES = [
  "DETERMINISTIC_BUY", "DETERMINISTIC_SELL", "VISION", "CONFLICT", "UNKNOWN",
] as const;
export type FacebookIntentSource = (typeof FACEBOOK_INTENT_SOURCES)[number];

export const FACEBOOK_IMAGE_RELEVANCE = ["PROPERTY_IMAGE", "NON_PROPERTY_IMAGE", "UNKNOWN"] as const;
export type FacebookImageRelevance = (typeof FACEBOOK_IMAGE_RELEVANCE)[number];
export type FacebookImageAssessment = {
  imageIndex: number;
  relevance: FacebookImageRelevance;
  confidence: number;
};

export type FacebookVisionExtraction = {
  isProperty: boolean;
  listingIntent: FacebookListingIntent;
  intentConfidence: number;
  title: string | null;
  description: string | null;
  visibleText: string | null;
  city: string | null;
  district: string | null;
  neighborhood: string | null;
  street: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  condition: "renovation" | "ready" | null;
  sellerType: "private" | "agency" | null;
  confidence: number;
  fieldConfidence?: FacebookFieldConfidence;
  imageAssessments: FacebookImageAssessment[];
  usage: FacebookVisionUsage;
};

export type FacebookVisionCostDataQuality = "EXACT" | "PARTIAL" | "UNAVAILABLE";

export type FacebookVisionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  model: string;
  requestId?: string | null;
  estimatedCostUsd: number | null;
  pricingSourceModel: string | null;
  pricingVersion: string;
  dataQuality: FacebookVisionCostDataQuality;
  diagnosticsReason?: "OPENAI_USAGE_UNAVAILABLE" | null;
};

export type FacebookOpenAIVisionSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  usageUnavailableCalls: number;
  models: string[];
};

export const FACEBOOK_CONFIDENCE_FIELDS = [
  "title", "description", "city", "district", "neighborhood", "street",
  "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType",
] as const;

export type FacebookConfidenceField = (typeof FACEBOOK_CONFIDENCE_FIELDS)[number];
export type FacebookFieldConfidence = Partial<Record<FacebookConfidenceField, number>>;

export type FacebookWorkerJob = {
  id: string;
  runId: string;
  sourceScanId: string;
  filterId: string;
  group: FacebookGroupSnapshot;
  leaseToken: string;
  leasedUntil: string;
  attempts: number;
};

export type FacebookCompletion = {
  jobId: string;
  leaseToken: string;
  workerId: string;
  posts: FacebookPostSnapshot[];
  warnings: string[];
  durationMs: number;
  performance: FacebookPerformanceMetrics;
  ageCache: FacebookAgeCacheEntry[];
};

export type FacebookCompletionResult = {
  source: "facebook";
  status: "completed";
  fetched: number;
  normalized: number;
  durationMs: number;
  postsReceived: number;
  postsProcessed: number;
  listingsCreated: number;
  listingsUpdated: number;
  listingsSkipped: number;
  matched: number;
  newMatches: number;
  extractionFailed: number;
  imagesMirrored: number;
  priceDrops: number;
  errors: number;
  skippedDiagnostics: Array<{
    job_id: string;
    source_scan_id: string;
    post_id: string | null;
    group_id: string;
    permalink: string | null;
    text_length: number;
    image_count: number;
    real_estate_language: boolean;
    structured_field_count: number;
    detected_fields: string[];
    classification: "not_a_property" | "non_sale_intent";
    reason_code: FacebookSkipReasonCode;
    text_preview: string;
  }>;
  persistenceDiagnostics: Array<{
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
  }>;
  postCache: FacebookPostCacheEntry[];
  ageCache: FacebookAgeCacheEntry[];
  performance: FacebookPerformanceMetrics;
  openaiVision: FacebookOpenAIVisionSummary;
  visionCostUsd: number | null;
  visionCostDataQuality: FacebookVisionCostDataQuality;
  visionPricingSourceModels: string[];
  visionPricingVersion: string;
  openaiVisionCalls: Array<{ postId: string | null; usage: FacebookVisionUsage }>;
};

export type FacebookSkipReasonCode =
  | "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS"
  | "FACEBOOK_BUY_REQUEST"
  | "FACEBOOK_RENT_REQUEST"
  | "FACEBOOK_SERVICE_POST"
  | "FACEBOOK_NON_SALE_POST"
  | "FACEBOOK_INTENT_UNKNOWN";

export type FacebookJobState = {
  status: FacebookJobStatus;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leasedUntil: number | null;
  heartbeatAt: number | null;
};

export function facebookJobIdempotencyKey(filterId: string, scanRunId: string, groupId: string): string {
  return `${filterId}:facebook:${scanRunId}:${groupId}`;
}

export function claimFacebookJobState(state: FacebookJobState, now: number, leaseMs = 180_000): FacebookJobState {
  const canRecover = state.status === "running" && state.leasedUntil !== null && state.leasedUntil < now;
  if (state.status !== "queued" && !canRecover) throw new Error("JOB_NOT_CLAIMABLE");
  if (state.attempts >= state.maxAttempts) throw new Error("LEASE_EXHAUSTED");
  return { ...state, status: "running", attempts: state.attempts + 1, leaseToken: `lease-${state.attempts + 1}`, leasedUntil: now + leaseMs, heartbeatAt: now };
}

export function heartbeatFacebookJobState(state: FacebookJobState, now: number, leaseMs = 180_000): FacebookJobState {
  if (state.status !== "running" || !state.leaseToken) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  return { ...state, heartbeatAt: now, leasedUntil: now + leaseMs };
}

export function settleFacebookJobState(state: FacebookJobState, status: "completed" | "failed"): FacebookJobState {
  if (state.status !== "running" || !state.leaseToken) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  return { ...state, status, leaseToken: null, leasedUntil: null };
}
