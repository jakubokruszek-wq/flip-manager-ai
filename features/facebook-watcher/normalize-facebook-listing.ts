import type { FacebookListingInput } from "./types";

export function normalizeFacebookUrl(value?: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/(^|\.)facebook\.com$|(^|\.)fb\.watch$/.test(url.hostname.toLowerCase())) return null;
    ["fbclid", "utm_source", "utm_medium", "utm_campaign"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

export function normalizeFacebookListing(input: FacebookListingInput): FacebookListingInput {
  return {
    url: normalizeFacebookUrl(input.url) ?? undefined,
    postText: input.postText?.replace(/\s+/g, " ").trim() || undefined,
    authorName: input.authorName?.trim() || undefined,
    groupName: input.groupName?.trim() || undefined,
    publishedAt: input.publishedAt || undefined,
    images: [...new Set((input.images ?? []).map((image) => image.trim()).filter(Boolean))].slice(0, 12),
    overrides: input.overrides,
    analysisConfidence: input.analysisConfidence,
    analysisFieldConfidence: input.analysisFieldConfidence,
    analysisFlags: input.analysisFlags,
    listingIntent: input.listingIntent,
    intentConfidence: input.intentConfidence,
    imageAssessments: input.imageAssessments,
  };
}

export function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
