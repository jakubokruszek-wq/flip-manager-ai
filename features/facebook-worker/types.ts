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
  text: string;
  imageUrls: string[];
  publishedAt: string | null;
  vision?: FacebookVisionExtraction | null;
};

export const FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES = ["POST_PAGE_METADATA", "POST_REGION_DOM", "SHARED_POST_FALLBACK", "CONFLICT", "NONE"] as const;
export type FacebookAuthoritativePostTextSource = (typeof FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES)[number];

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
  groups: FacebookGroupSnapshot[];
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

export function facebookJobIdempotencyKey(filterId: string, scanRunId: string): string {
  return `${filterId}:facebook:${scanRunId}`;
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
