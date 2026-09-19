/**
 * Server-side mirror of the extension's classifyPostAgeZone
 * (extensions/facebook-collector/collector-core.js). Facebook group feeds are
 * ranked/reordered, not chronological — age must never be used to infer
 * anything about feed position, only to gate expensive per-post server work.
 * An unparseable timestamp is conservative: it is never treated as OLD, since
 * it might be a fresh post whose date just could not be read reliably.
 */
export const AGE_WINDOW_72H_MS = 72 * 60 * 60 * 1000;

export type FacebookPostAgeZone = "FRESH" | "OLD" | "UNKNOWN";

export function classifyFacebookPostAgeZone(publishedAt: string | null | undefined, now: number = Date.now(), freshMs: number = AGE_WINDOW_72H_MS): FacebookPostAgeZone {
  const timestamp = typeof publishedAt === "string" ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "UNKNOWN";
  const age = now - timestamp;
  if (age < 0) return "FRESH"; // clock skew / future timestamp: never penalize
  return age <= freshMs ? "FRESH" : "OLD";
}

/** Whether a rediscovered post is eligible for Vision, image mirroring, gallery enqueue and current-candidate persistence. UNKNOWN is conservative and stays eligible. */
export function isEligibleForCurrentProcessing(ageZone: FacebookPostAgeZone): boolean {
  return ageZone !== "OLD";
}
