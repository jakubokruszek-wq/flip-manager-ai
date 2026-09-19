/**
 * Decides whether a Facebook listing should have deeper gallery hydration
 * (features/facebook-worker/gallery-jobs.ts) queued automatically at persist
 * time, instead of waiting for a manual "POBIERZ ZDJĘCIA" click.
 *
 * Priority order for a listing's images is: (1) verified image URLs already
 * present on the post/search payload, (2) the source post's own images —
 * both already mirrored synchronously into storage before this decision runs
 * — and only when neither yielded anything do we fall back to (3) queuing the
 * collector's separate media-viewer re-scrape. A REVIEW-bucket candidate is
 * exactly as eligible as a MATCHED one: needing manual review is a data-
 * completeness signal, not a reason to leave the card without a photo.
 */
export type FacebookDecisionBucket = "MATCHED" | "REVIEW" | "REJECTED";

export function shouldAutoEnrichFacebookImages(input: { bucket: FacebookDecisionBucket; manualRejected: boolean; mirroredImageCount: number }): boolean {
  if (input.manualRejected || input.bucket === "REJECTED") return false;
  return input.mirroredImageCount === 0;
}
