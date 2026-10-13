/**
 * Publication age is information for the operator, never a reason on its own
 * to hide an active, currently matching listing. Production (2026-10-13)
 * proved the old hard 30-day visibility window hid three of four persisted
 * matches for filter "Flip". The threshold below only drives the "older
 * listing" badge and the optional client-side age filter.
 */
export const FINDER_OLDER_LISTING_DAYS = 30;
/** Last confirmation by a source scan older than this is shown as "aktualność niepotwierdzona". */
export const FINDER_UNCONFIRMED_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

export type PublicationAgeFilter = "all" | "7" | "14" | "30" | "older";
export const PUBLICATION_AGE_FILTERS: readonly PublicationAgeFilter[] = ["all", "7", "14", "30", "older"];

export type ListingFreshness = {
  /** Whole days since the earliest known source publication date; null when unknown. */
  ageDays: number | null;
  /** True when the listing was published more than FINDER_OLDER_LISTING_DAYS ago. */
  isOlderListing: boolean;
  /** Whole days since a scan last saw the listing on its source; null when unknown. */
  lastVerifiedDaysAgo: number | null;
  /** True when no scan has confirmed the listing for FINDER_UNCONFIRMED_AFTER_DAYS. */
  verificationStale: boolean;
};

/** Accept only source-provided publication timestamps, never import/update dates. */
export function normalizePublicationDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return null;
  return new Date(timestamp).toISOString();
}

export function publicationAgeDays(value: unknown, now = Date.now()): number | null {
  const normalized = normalizePublicationDate(value, now);
  return normalized === null ? null : Math.floor((now - Date.parse(normalized)) / DAY_MS);
}

export function listingFreshness(publishedAt: unknown, lastSeenAt: unknown, now = Date.now()): ListingFreshness {
  const ageDays = publicationAgeDays(publishedAt, now);
  const published = normalizePublicationDate(publishedAt, now);
  const lastSeen = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : Number.NaN;
  const lastVerifiedDaysAgo = Number.isFinite(lastSeen) ? Math.max(0, Math.floor((now - lastSeen) / DAY_MS)) : null;
  return {
    ageDays,
    isOlderListing: published !== null && Date.parse(published) < now - FINDER_OLDER_LISTING_DAYS * DAY_MS,
    lastVerifiedDaysAgo,
    verificationStale: lastVerifiedDaysAgo === null || lastVerifiedDaysAgo > FINDER_UNCONFIRMED_AFTER_DAYS,
  };
}

/**
 * Client-side, operator-chosen age filter. Unknown publication dates are kept
 * by every bounded filter except "older", so a missing date never hides an
 * offer silently.
 */
export function matchesPublicationAgeFilter(publishedAt: unknown, filter: PublicationAgeFilter, now = Date.now()): boolean {
  if (filter === "all") return true;
  const ageDays = publicationAgeDays(publishedAt, now);
  if (filter === "older") return listingFreshness(publishedAt, null, now).isOlderListing;
  return ageDays === null || ageDays <= Number(filter);
}

export function parsePublicationAgeFilter(value: unknown): PublicationAgeFilter {
  return PUBLICATION_AGE_FILTERS.includes(value as PublicationAgeFilter) ? value as PublicationAgeFilter : "all";
}

export function formatPublicationLabel(value: unknown, now = Date.now()): string {
  const normalized = normalizePublicationDate(value, now);
  if (!normalized) return "Data publikacji nieznana";
  return `Opublikowano: ${new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Warsaw",
  }).format(new Date(normalized))}`;
}

export function formatListingAge(ageDays: number | null): string {
  if (ageDays === null) return "Wiek oferty nieznany";
  if (ageDays === 0) return "Wiek oferty: dziś";
  return `Wiek oferty: ${ageDays} ${ageDays === 1 ? "dzień" : "dni"}`;
}

/** Never let a later reimport replace an older known publication date. */
export function earliestPublicationDate(values: readonly unknown[], now = Date.now()): string | null {
  const dates = values.map((value) => normalizePublicationDate(value, now)).filter((value): value is string => value !== null);
  return dates.length ? dates.reduce((earliest, current) => Date.parse(current) < Date.parse(earliest) ? current : earliest) : null;
}

/** The most recent source-reported publication (e.g. a portal "refresh"), kept separately for display only. */
export function latestPublicationDate(values: readonly unknown[], now = Date.now()): string | null {
  const dates = values.map((value) => normalizePublicationDate(value, now)).filter((value): value is string => value !== null);
  return dates.length ? dates.reduce((latest, current) => Date.parse(current) > Date.parse(latest) ? current : latest) : null;
}
