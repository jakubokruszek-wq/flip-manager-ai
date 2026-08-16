import type { FacebookPostSnapshot } from "./types";

export type FacebookPostImportResult = {
  status: "created" | "updated" | "skipped";
  listingId: string | null;
  listingCreated: boolean;
  listingUpdated: boolean;
  matched: boolean;
  matchCreated: boolean;
  imagesMirrored: number;
  priceDrops: number;
  warnings: string[];
  notProperty?: {
    realEstateLanguage: boolean;
    structuredFieldCount: number;
    detectedFields: string[];
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
  classification: "not_a_property";
  reason_code: "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS";
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
  listingIds: string[];
  warnings: string[];
  skippedDiagnostics: FacebookSkippedDiagnostic[];
};

export async function processFacebookPostBatch(
  posts: FacebookPostSnapshot[],
  importPost: (post: FacebookPostSnapshot) => Promise<FacebookPostImportResult>,
  context?: { jobId: string; sourceScanId: string },
): Promise<FacebookPostFlowSummary> {
  const summary: FacebookPostFlowSummary = {
    postsReceived: posts.length, postsProcessed: 0, listingsCreated: 0, listingsUpdated: 0,
    listingsSkipped: 0, matched: 0, newMatches: 0, extractionFailed: 0,
    imagesMirrored: 0, priceDrops: 0, errors: 0, listingIds: [], warnings: [], skippedDiagnostics: [],
  };

  for (const post of posts) {
    summary.postsProcessed += 1;
    if (!post.postId && !post.permalink) {
      summary.listingsSkipped += 1;
      summary.warnings.push("Pominięto post bez stabilnego ID i permalinku.");
      continue;
    }
    try {
      const result = await importPost(post);
      summary.listingsCreated += result.listingCreated ? 1 : 0;
      summary.listingsUpdated += result.listingUpdated ? 1 : 0;
      summary.listingsSkipped += result.status === "skipped" ? 1 : 0;
      summary.matched += result.matched ? 1 : 0;
      summary.newMatches += result.matchCreated ? 1 : 0;
      summary.imagesMirrored += result.imagesMirrored;
      summary.priceDrops += result.priceDrops;
      summary.warnings.push(...result.warnings);
      if (result.status === "skipped" && result.notProperty && context && summary.skippedDiagnostics.length < 3) {
        summary.skippedDiagnostics.push(createSkippedDiagnostic(post, result.notProperty, context));
      }
      if (result.listingId && !summary.listingIds.includes(result.listingId)) summary.listingIds.push(result.listingId);
    } catch (error) {
      summary.extractionFailed += 1;
      summary.errors += 1;
      summary.warnings.push(`Post nie został przetworzony: ${safeErrorCode(error)}.`);
    }
  }
  return summary;
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
  return { job_id: context.jobId, source_scan_id: context.sourceScanId, post_id: post.postId, group_id: post.groupId, permalink: post.permalink, text_length: post.text.length, image_count: post.imageUrls.length, real_estate_language: signals.realEstateLanguage, structured_field_count: signals.structuredFieldCount, detected_fields: signals.detectedFields.slice(0, 10), classification: "not_a_property", reason_code: "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS", text_preview: redactFacebookPostPreview(post.text) };
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 100);
  if (error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)) return error.message.slice(0, 100);
  return "FACEBOOK_POST_EXTRACTION_FAILED";
}
