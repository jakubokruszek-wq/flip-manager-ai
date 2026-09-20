import type { FacebookIntentSource, FacebookListingIntent, FacebookPostPerformanceTiming, FacebookPostSnapshot, FacebookSkipReasonCode } from "./types";
import { classifyFacebookPostAgeZone } from "../facebook-watcher/post-age-zone.ts";
import { classifyExtractionException, classifyFacebookDecision, classifyFacebookSkip, type FacebookPostOutcome } from "./scan-accounting.ts";

export type FacebookPersistenceDiagnostics = {
  /** Safe per-post image/persistence trace. Optional for backwards-compatible batches. */
  listingId?: string | null;
  decision?: "MATCHED" | "REVIEW" | "REJECTED" | null;
  lifecycleStatus?: string | null;
  existingListingFound?: boolean;
  existingListingLifecycle?: string | null;
  existingListingImageCount?: number;
  incomingImageCount?: number;
  imagePersistenceAttempted?: boolean;
  storageUploadAttempted?: number;
  storageUploadSuccess?: number;
  storageUploadFailed?: number;
  storageFailureReason?: string | null;
  imagesBeforeUpdate?: number;
  imagesAfterUpdate?: number;
  thumbnailBeforePresent?: boolean;
  thumbnailAfterPresent?: boolean;
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
  decisionReasons?: string[];
  decisionUnknownFields?: string[];
  imageProvenance: FacebookImageProvenanceDiagnostic[];
};

export type FacebookImageProvenanceDiagnostic = {
  structuredPostMediaProvenance: boolean;
  provenanceReasonCode: string;
  expectedPostId: string;
  detectedStoryRootPostId: string | null;
  bindingMethod: string;
  bindingConfidence: number | null;
  mediaId: string | null;
  normalizedMediaUrl: string | null;
  relevanceClassification: string;
  relevanceConfidence: number | null;
  finalVerified: boolean;
  rejectionReason: string | null;
};

export type FacebookPostImportResult = {
  status: "created" | "updated" | "reused" | "skipped";
  listingId: string | null;
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
    reasonCode?: FacebookSkipReasonCode;
    listingIntent?: FacebookListingIntent;
    intentSource?: FacebookIntentSource;
  };
};

export type FacebookSkippedDiagnostic = {
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
};

export type FacebookPostFlowSummary = {
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
  oldPostsSkippedHeavyProcessing: number;
  listingIds: string[];
  warnings: string[];
  skippedDiagnostics: FacebookSkippedDiagnostic[];
  persistenceDiagnostics: FacebookPersistenceDiagnostics[];
  postTimings: FacebookPostPerformanceTiming[];
  reusablePosts: Array<
    | { postId: string; listingId: string; publishedAt: string; outcome: "SELL_PERSISTED" }
    | { postId: string; listingId: null; publishedAt: string; outcome: "DETERMINISTIC_SKIP"; reasonCode: FacebookSkipReasonCode; listingIntent: FacebookListingIntent; intentSource: FacebookIntentSource }
  >;
  /** One deterministic accounting outcome per post this call actually attempted (see scan-accounting.ts). Excludes posts the caller filtered out before this call (e.g. unverified identity/stale) — the caller merges those in separately. */
  outcomes: FacebookPostOutcome[];
};

export async function processFacebookPostBatch(
  posts: FacebookPostSnapshot[],
  importPost: (post: FacebookPostSnapshot) => Promise<FacebookPostImportResult>,
  context?: { jobId: string; sourceScanId: string },
): Promise<FacebookPostFlowSummary> {
  const summary: FacebookPostFlowSummary = {
    postsReceived: posts.length, postsProcessed: 0, listingsCreated: 0, listingsUpdated: 0,
    listingsSkipped: 0, matched: 0, newMatches: 0, extractionFailed: 0,
    imagesMirrored: 0, priceDrops: 0, errors: 0, oldPostsSkippedHeavyProcessing: 0, listingIds: [], warnings: [], skippedDiagnostics: [], persistenceDiagnostics: [], postTimings: [], reusablePosts: [], outcomes: [],
  };

  for (const post of posts) {
    summary.postsProcessed += 1;
    const postStarted = Date.now();
    if (!post.postId && !post.permalink) {
      summary.listingsSkipped += 1;
      summary.warnings.push("Pominięto post bez stabilnego ID i permalinku.");
      summary.outcomes.push({ postId: null, primaryOutcome: "IDENTITY_UNVERIFIED", reasonCodes: ["identity_unverified"] });
      continue;
    }
    try {
      const result = await importPost(post);
      summary.outcomes.push({ ...classifyPostImportResult(result), postId: post.postId });
      summary.listingsCreated += result.listingCreated ? 1 : 0;
      summary.listingsUpdated += result.listingUpdated ? 1 : 0;
      summary.listingsSkipped += result.status === "skipped" ? 1 : 0;
      summary.matched += result.matched ? 1 : 0;
      summary.newMatches += result.matchCreated ? 1 : 0;
      summary.imagesMirrored += result.imagesMirrored;
      summary.priceDrops += result.priceDrops;
      if (result.status === "skipped" && result.notProperty?.reasonCode === "FACEBOOK_STALE_POST_OLDER_THAN_72H" && classifyFacebookPostAgeZone(post.publishedAt) === "OLD") {
        summary.oldPostsSkippedHeavyProcessing += 1;
      }
      summary.warnings.push(...result.warnings);
      summary.persistenceDiagnostics.push(result.persistenceDiagnostics ?? createEmptyPersistenceDiagnostics(post));
      const persistenceMs = result.status === "reused" ? 0 : Date.now() - postStarted;
      summary.postTimings.push({ postId: post.postId ?? post.permalink ?? "unknown", feedDiscoveryMs: 0, ageDetectionMs: 0, ageFallbackMs: 0, dedicatedPageNavigationMs: 0, extractionMs: 0, visionMs: 0, persistenceMs, completionMs: 0, totalMs: persistenceMs, cacheHit: result.status === "reused" });
      if (result.status === "skipped" && result.notProperty && context && summary.skippedDiagnostics.length < 3) {
        summary.skippedDiagnostics.push(createSkippedDiagnostic(post, result.notProperty, context));
      }
      if (result.status !== "reused" && result.listingId && !summary.listingIds.includes(result.listingId)) summary.listingIds.push(result.listingId);
      if (result.status !== "skipped" && result.listingId && post.postId && post.publishedAt) {
        summary.reusablePosts.push({ postId: post.postId, listingId: result.listingId, publishedAt: post.publishedAt, outcome: "SELL_PERSISTED" });
      } else if (result.status === "skipped" && post.postId && post.publishedAt && isSafeDeterministicSkip(result.notProperty)) {
        const skip = result.notProperty!;
        summary.reusablePosts.push({ postId: post.postId, listingId: null, publishedAt: post.publishedAt, outcome: "DETERMINISTIC_SKIP", reasonCode: skip.reasonCode!, listingIntent: skip.listingIntent!, intentSource: skip.intentSource! });
      }
    } catch (error) {
      summary.extractionFailed += 1;
      summary.errors += 1;
      const errorCode = safeErrorCode(error);
      summary.outcomes.push({ ...classifyExtractionException(errorCode), postId: post.postId });
      summary.warnings.push(`Post nie został przetworzony: ${errorCode}.`);
    }
  }
  return summary;
}

/**
 * Files a successfully-returned (non-throwing) result into the accounting
 * taxonomy without re-deriving or second-guessing any decision: it only
 * reads fields the pipeline already computed (a controlled skip's own
 * reasonCode/warnings, or the canonical decision's own bucket/reasons/
 * unknownFields carried on persistenceDiagnostics). A result predating this
 * accounting (no persistenceDiagnostics.decision, not a skip) degrades to a
 * conservative, clearly-labeled fallback based on whether it matched —
 * never a fabricated reason.
 */
function classifyPostImportResult(result: FacebookPostImportResult): FacebookPostOutcome {
  if (result.status === "skipped" && result.notProperty) {
    return classifyFacebookSkip({ reasonCode: result.notProperty.reasonCode, warnings: result.warnings });
  }
  const decision = result.persistenceDiagnostics?.decision;
  if (decision) {
    return classifyFacebookDecision({ bucket: decision, reasons: result.persistenceDiagnostics?.decisionReasons ?? [], unknownFields: result.persistenceDiagnostics?.decisionUnknownFields ?? [] });
  }
  return result.matched
    ? { postId: null, primaryOutcome: "MATCHED", reasonCodes: [] }
    : { postId: null, primaryOutcome: "REVIEW", reasonCodes: ["no_decision_snapshot"] };
}

function createEmptyPersistenceDiagnostics(post: FacebookPostSnapshot): FacebookPersistenceDiagnostics {
  return {
    postId: post.postId,
    creationTime: post.publishedAt,
    timestampSource: post.publishedAt ? "POST_PAGE" : "UNKNOWN",
    publishedAtCandidate: post.publishedAt,
    publishedAtPersistAttempted: false,
    publishedAtPersisted: false,
    exactBoundCandidates: 0,
    relevanceAccepted: 0,
    relevanceRejected: 0,
    mirrorAttempted: 0,
    mirroredCount: 0,
    persistedNewImageCount: 0,
    finalListingImageCount: 0,
    persistedImageCount: 0,
    imageReasonCode: "NONE",
    reasonCodes: [],
    imageProvenance: [],
  };
}

function isSafeDeterministicSkip(value: FacebookPostImportResult["notProperty"]): boolean {
  if (!value || (value.intentSource !== "DETERMINISTIC_BUY" && value.intentSource !== "DETERMINISTIC_SELL")) return false;
  return (value.reasonCode === "FACEBOOK_BUY_REQUEST" && value.listingIntent === "BUY_PROPERTY")
    || (value.reasonCode === "FACEBOOK_RENT_REQUEST" && (value.listingIntent === "RENT_OFFER" || value.listingIntent === "RENT_WANTED"))
    || (value.reasonCode === "FACEBOOK_SERVICE_POST" && value.listingIntent === "SERVICE");
}

export function redactFacebookPostPreview(text: string): string {
  return text
    .replace(/^\s*(?:autor|author|opublikowane przez)\s*:\s*[^\r\n]+/gimu, "[AUTOR USUNIETY]")
    .replace(/[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu, "[EMAIL USUNIETY]")
    .replace(/(?<!\d)(?:\+?48[\s.-]?)?(?:\d[\s.-]?){9}(?!\d)/g, "[TELEFON USUNIETY]")
    .replace(/\b(cookie|token|access_token|authorization|session)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function createSkippedDiagnostic(post: FacebookPostSnapshot, signals: NonNullable<FacebookPostImportResult["notProperty"]>, context: { jobId: string; sourceScanId: string }): FacebookSkippedDiagnostic {
  return { job_id: context.jobId, source_scan_id: context.sourceScanId, post_id: post.postId, group_id: post.groupId, permalink: post.permalink, text_length: post.text.length, image_count: post.imageUrls.length, real_estate_language: signals.realEstateLanguage, structured_field_count: signals.structuredFieldCount, detected_fields: signals.detectedFields.slice(0, 10), classification: signals.classification ?? "not_a_property", reason_code: signals.reasonCode ?? "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS", text_preview: redactFacebookPostPreview(post.text) };
}

/**
 * Every internal throw site in this pipeline names itself as `CODE: detail`
 * (e.g. "FACEBOOK_METADATA_PERSIST_FAILED: duplicate key..."). Requiring the
 * WHOLE message to be a bare code discarded that name the moment any detail
 * followed the colon, collapsing distinct, already-diagnosed failures
 * (metadata persistence, score persistence, image persistence, ...) into one
 * uninformative FACEBOOK_POST_EXTRACTION_FAILED bucket. Extracting the
 * leading identifier keeps that name whenever one exists, and only falls
 * back to the generic code for a message that never had one to begin with.
 */
function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 100);
  if (error instanceof Error) {
    const prefix = error.message.match(/^([A-Z][A-Z0-9_]*)(?:\s*:|\s*$)/);
    if (prefix) return prefix[1].slice(0, 100);
  }
  return "FACEBOOK_POST_EXTRACTION_FAILED";
}
