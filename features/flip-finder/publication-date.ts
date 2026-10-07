export const FINDER_PUBLICATION_MAX_AGE_DAYS = 21;
const DAY_MS = 86_400_000;

/** Accept only source-provided publication timestamps, never import/update dates. */
export function normalizePublicationDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return null;
  return new Date(timestamp).toISOString();
}

/** Missing/invalid dates remain visible; known listings older than 21 days do not. */
export function isWithinFinderPublicationWindow(value: unknown, now = Date.now()): boolean {
  const normalized = normalizePublicationDate(value, now);
  return normalized === null || Date.parse(normalized) >= now - FINDER_PUBLICATION_MAX_AGE_DAYS * DAY_MS;
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

/** Never let a later reimport replace an older known publication date. */
export function earliestPublicationDate(values: readonly unknown[], now = Date.now()): string | null {
  const dates = values.map((value) => normalizePublicationDate(value, now)).filter((value): value is string => value !== null);
  return dates.length ? dates.reduce((earliest, current) => Date.parse(current) < Date.parse(earliest) ? current : earliest) : null;
}
