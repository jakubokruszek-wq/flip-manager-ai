import { revalidateFacebookPostImages } from "./browser.ts";
import { logFacebookWorker } from "./logger.ts";
import type { FacebookWorkerConfig } from "./config.ts";

export type FacebookImageRevalidationArgs = { enabled: boolean; dryRun: boolean; limit: number; listingId: string | null; postId: string | null };

export function parseFacebookImageRevalidationArguments(argv: string[]): FacebookImageRevalidationArgs {
  const enabled = argv.includes("--revalidate-images");
  const dryRun = !argv.includes("--apply");
  const limitArgument = argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument ? Number(limitArgument.slice("--limit=".length)) : 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be an integer between 1 and 50.");
  const listingId = readOptionalId(argv, "--listing-id=");
  const postId = readOptionalId(argv, "--post-id=");
  if (listingId && postId) throw new Error("--listing-id and --post-id cannot be combined.");
  return { enabled, dryRun, limit, listingId, postId };
}

export async function runFacebookImageRevalidation(config: FacebookWorkerConfig, api: ReturnType<typeof import("./api-client.ts").createFacebookApiClient>, args: FacebookImageRevalidationArgs, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  const targets = (await api.revalidationList({ limit: args.limit, listingId: args.listingId ?? undefined, postId: args.postId ?? undefined, dryRun: args.dryRun }, signal)).targets;
  const results = [];
  for (const target of targets) {
    const itemStarted = Date.now();
    try {
      const browser = await revalidateFacebookPostImages(config.profileDir, target, signal, (input, innerSignal) => api.revalidationVision(input, innerSignal).then((result) => result.vision));
      const persisted = await api.revalidationPersist({ listingId: target.listingId, postId: target.postId, dryRun: args.dryRun, candidates: browser.candidates, verifiedCandidates: browser.verifiedCandidates, pageOpens: browser.pageOpens, visionCalls: browser.visionCalls, durationMs: Date.now() - itemStarted }, signal);
      results.push(persisted);
      logFacebookWorker("FACEBOOK_IMAGE_REVALIDATION_LISTING", { listingId: target.listingId, postId: target.postId, status: persisted.status, beforeCount: persisted.beforeCount, afterCount: persisted.afterCount, candidates: persisted.candidates, verifiedImages: persisted.verifiedImages, rejectedImages: persisted.rejectedImages, rejectionReasons: persisted.rejectionReasons, pageOpens: persisted.pageOpens, visionCalls: persisted.visionCalls, durationMs: persisted.durationMs, dryRun: args.dryRun });
    } catch (error) {
      const result = { listingId: target.listingId, postId: target.postId, status: "FAILED", beforeCount: target.currentImages.length, afterCount: target.currentImages.length, candidates: 0, verifiedImages: 0, rejectedImages: 0, rejectionReasons: [error instanceof Error ? error.message.slice(0, 200) : "FACEBOOK_REVALIDATION_FAILED"], visionCalls: 0, pageOpens: 0, durationMs: Date.now() - itemStarted, wouldReplaceGallery: false } as const;
      results.push(result);
      logFacebookWorker("FACEBOOK_IMAGE_REVALIDATION_LISTING", { listingId: result.listingId, postId: result.postId, status: result.status, beforeCount: result.beforeCount, afterCount: result.afterCount, candidates: result.candidates, verifiedImages: result.verifiedImages, rejectedImages: result.rejectedImages, rejectionReasons: result.rejectionReasons, pageOpens: result.pageOpens, visionCalls: result.visionCalls, durationMs: result.durationMs, dryRun: args.dryRun });
    }
  }
  logFacebookWorker("FACEBOOK_IMAGE_REVALIDATION_SUMMARY", { dryRun: args.dryRun, listingsChecked: results.length, success: results.filter((item) => item.status === "SUCCESS" || item.status === "DRY_RUN").length, failed: results.filter((item) => item.status === "FAILED").length, unchanged: results.filter((item) => item.status === "UNKNOWN").length, galleriesReplaced: results.filter((item) => item.status === "SUCCESS").length, verifiedImages: results.reduce((sum, item) => sum + item.verifiedImages, 0), rejectedImages: results.reduce((sum, item) => sum + item.rejectedImages, 0), visionCalls: results.reduce((sum, item) => sum + item.visionCalls, 0), durationMs: Date.now() - started });
}

function readOptionalId(argv: string[], prefix: string): string | null {
  const argument = argv.find((value) => value.startsWith(prefix));
  if (!argument) return null;
  const value = argument.slice(prefix.length).trim();
  if (!value || value.length > 300) throw new Error(`${prefix} requires a value.`);
  return value;
}
