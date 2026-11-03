import { EMPTY_FACEBOOK_INBOX_FILTERS, type FacebookInboxFilters } from "./facebook-inbox";

export const WATCHER_FILTER_STORAGE_KEY = "facebook-watcher-view-filters-v1";
const numericKeys = ["minPrice", "maxPrice", "minArea", "maxArea", "maxPricePerSqm", "rooms", "minFloor", "maxFloor", "minProfit", "minFlipScore", "minOpportunityScore", "publishedDays"] as const;

export function readSavedInboxFilters(value: string | null): FacebookInboxFilters | null {
  if (!value || value.length > 20_000) return null;
  try {
    const stored: unknown = JSON.parse(value);
    if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("filters" in stored)) return null;
    const raw = stored.filters;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const result: FacebookInboxFilters = { ...EMPTY_FACEBOOK_INBOX_FILTERS, roomOptions: [] };
    for (const key of ["query", "neighborhood", "district", "group"] as const) {
      if (typeof row[key] === "string") result[key] = row[key].slice(0, 500);
    }
    for (const key of numericKeys) result[key] = typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0 ? row[key] : null;
    if (row.sellerType === "private" || row.sellerType === "agency") result.sellerType = row.sellerType;
    if (row.condition === "renovation" || row.condition === "ready") result.condition = row.condition;
    if (row.marketType === "primary" || row.marketType === "secondary") result.marketType = row.marketType;
    result.roomOptions = Array.isArray(row.roomOptions) ? [...new Set(row.roomOptions.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 6))] : [];
    result.excludeGroundFloor = row.excludeGroundFloor === true;
    result.excludeTopFloor = row.excludeTopFloor === true;
    return result;
  } catch { return null; }
}

export function inboxRangeError(filters: FacebookInboxFilters): string | null {
  for (const [min, max, label] of [
    [filters.minPrice, filters.maxPrice, "Cena"],
    [filters.minArea, filters.maxArea, "Powierzchnia"],
    [filters.minFloor, filters.maxFloor, "Piętro"],
  ] as const) {
    if (typeof min === "number" && typeof max === "number" && min > max) return `${label}: wartość od nie może przekraczać wartości do.`;
  }
  return null;
}

export function subscribeInboxFilters(onChange: () => void): () => void {
  const handle = (event: StorageEvent) => { if (event.key === WATCHER_FILTER_STORAGE_KEY || event.key === null) onChange(); };
  window.addEventListener("storage", handle);
  return () => window.removeEventListener("storage", handle);
}
export function inboxFilterStorageSnapshot(): string | null {
  try { return window.localStorage.getItem(WATCHER_FILTER_STORAGE_KEY); } catch { return null; }
}
export const inboxFilterServerSnapshot = () => null;
