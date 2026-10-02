import { extractOtodomListingId, isConfirmedOtodomOfferUrl } from "./otodom-search";

/**
 * Stable, bounded reasons exposed to the Finder operator when an Otodom row
 * cannot become a saved listing. Keep these values machine-readable: the UI
 * and scan history use the same strings, while the adapter can still render
 * a short Polish explanation for a human.
 */
export const OTODOM_REJECTION_REASONS = [
  "invalid_url",
  "search_or_category_url",
  "missing_offer_id",
  "placeholder_url",
  "missing_title",
  "missing_price",
  "missing_area",
  "parser_error",
  "duplicate",
  "unsupported_listing",
] as const;

export type OtodomRejectionReason = (typeof OTODOM_REJECTION_REASONS)[number];
export type OtodomRejectionCounts = Partial<Record<OtodomRejectionReason, number>>;

export function classifyOtodomUrl(value: string | null | undefined): OtodomRejectionReason | null {
  if (!value?.trim()) return "invalid_url";
  const trimmed = value.trim();
  if (/^manual:|\/flip-manager\/manual\/|\[[^\]]+\]/i.test(trimmed)) return "placeholder_url";
  // A search result may expose either an absolute URL or a relative href.
  // Let URL resolve the latter against the trusted Otodom origin, while
  // rejecting non-HTTP schemes before they can be treated as a path.
  const hasHttpScheme = /^https?:\/\//i.test(trimmed);
  const hasOtherScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !hasHttpScheme;
  const isRelativePath = /^(?:\/|\.\.?\/|pl\/)/i.test(trimmed);
  if (hasOtherScheme || (!hasHttpScheme && !isRelativePath)) return "invalid_url";

  let url: URL;
  try {
    url = new URL(trimmed, "https://www.otodom.pl");
  } catch {
    return "invalid_url";
  }

  if (url.protocol !== "https:" || !/(^|\.)otodom\.pl$/i.test(url.hostname)) {
    return "invalid_url";
  }
  if (!/^\/pl\/oferta\//i.test(url.pathname)) return "search_or_category_url";
  if (!extractOtodomListingId(url.toString())) return "missing_offer_id";
  return isConfirmedOtodomOfferUrl(url.toString()) ? null : "invalid_url";
}

export function humanizeOtodomRejectionReason(reason: OtodomRejectionReason, count: number): string {
  return `Otodom: ${reason} (${count})`;
}

export function rejectionWarnings(counts: OtodomRejectionCounts): string[] {
  return OTODOM_REJECTION_REASONS
    .filter((reason) => (counts[reason] ?? 0) > 0)
    .map((reason) => humanizeOtodomRejectionReason(reason, counts[reason] ?? 0));
}
