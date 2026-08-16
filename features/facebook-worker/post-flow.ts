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
};

export async function processFacebookPostBatch(
  posts: FacebookPostSnapshot[],
  importPost: (post: FacebookPostSnapshot) => Promise<FacebookPostImportResult>,
): Promise<FacebookPostFlowSummary> {
  const summary: FacebookPostFlowSummary = {
    postsReceived: posts.length, postsProcessed: 0, listingsCreated: 0, listingsUpdated: 0,
    listingsSkipped: 0, matched: 0, newMatches: 0, extractionFailed: 0,
    imagesMirrored: 0, priceDrops: 0, errors: 0, listingIds: [], warnings: [],
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
      if (result.listingId && !summary.listingIds.includes(result.listingId)) summary.listingIds.push(result.listingId);
    } catch (error) {
      summary.extractionFailed += 1;
      summary.errors += 1;
      summary.warnings.push(`Post nie został przetworzony: ${safeErrorCode(error)}.`);
    }
  }
  return summary;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 100);
  if (error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)) return error.message.slice(0, 100);
  return "FACEBOOK_POST_EXTRACTION_FAILED";
}
