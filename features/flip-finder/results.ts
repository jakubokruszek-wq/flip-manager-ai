export type ResultSort =
  | "newest"
  | "price_asc"
  | "price_per_sqm_asc"
  | "biggest_price_drop";

export type CompletedScanWindow = {
  startedAt: string;
  finishedAt: string;
};

export type ResultStatusInput = {
  firstMatchedAt: string;
  previousPrice: number | null;
  currentPrice: number | null;
};

export type FilterResult = PropertyListingResult;

export function filterResultsByText(results: FilterResult[], query: string): FilterResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return results;
  }

  return results.filter((result) =>
    [
      result.title,
      result.address,
      result.district,
      result.city,
      result.description,
      result.source,
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalizeSearchText(value).includes(normalizedQuery)),
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("pl-PL");
}

export function filterMatchesForFilter<T extends { searchFilterId: string }>(
  matches: T[],
  filterId: string,
): T[] {
  return matches.filter((match) => match.searchFilterId === filterId);
}

export function isFilterMissing<T>(filter: T | null): filter is null {
  return filter === null;
}

type SortableResult = Pick<
  FilterResult,
  | "publishedAt"
  | "lastSeenAt"
  | "price"
  | "pricePerSqm"
  | "priceDropAmount"
>;

export function isNewMatch(
  firstMatchedAt: string,
  latestCompletedScan: CompletedScanWindow | null,
): boolean {
  if (!latestCompletedScan) {
    return false;
  }

  const matchedAt = Date.parse(firstMatchedAt);
  const startedAt = Date.parse(latestCompletedScan.startedAt);
  const finishedAt = Date.parse(latestCompletedScan.finishedAt);

  if (
    Number.isNaN(matchedAt) ||
    Number.isNaN(startedAt) ||
    Number.isNaN(finishedAt) ||
    finishedAt < startedAt
  ) {
    return false;
  }

  return matchedAt >= startedAt && matchedAt <= finishedAt;
}

export function resultStatus(
  input: ResultStatusInput,
  latestCompletedScan: CompletedScanWindow | null,
): { isNew: boolean; hasPriceDrop: boolean; priceDropAmount: number | null } {
  const isNew = isNewMatch(input.firstMatchedAt, latestCompletedScan);

  if (
    input.previousPrice !== null &&
    input.currentPrice !== null &&
    input.currentPrice < input.previousPrice
  ) {
    return {
      isNew,
      hasPriceDrop: true,
      priceDropAmount: input.previousPrice - input.currentPrice,
    };
  }

  return {
    isNew,
    hasPriceDrop: false,
    priceDropAmount: null,
  };
}

export function parseResultSort(value: string | null): ResultSort {
  return value === "price_asc" ||
    value === "price_per_sqm_asc" ||
    value === "biggest_price_drop"
    ? value
    : "newest";
}

export function sortResults<T extends SortableResult>(items: T[], sort: ResultSort): T[] {
  return items.map((item, index) => ({ item, index })).sort((leftEntry, rightEntry) => {
    const left = leftEntry.item;
    const right = rightEntry.item;
    let comparison = 0;
    if (sort === "price_asc") {
      comparison = positiveNumericSort(left.price, right.price);
    } else if (sort === "price_per_sqm_asc") {
      comparison = positiveNumericSort(left.pricePerSqm, right.pricePerSqm);
    } else if (sort === "biggest_price_drop") {
      comparison = descendingNumericSort(left.priceDropAmount, right.priceDropAmount);
    } else {
      comparison = publicationSort(left, right);
    }
    return comparison || leftEntry.index - rightEntry.index;
  }).map(({ item }) => item);
}

export function publicationLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Data publikacji: nieznana";
  return `Opublikowano: ${new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}`;
}

export function resultLocation(
  address: string | null,
  district: string | null,
  city: string | null,
): string | null {
  const values = [address, district, city].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  return values.length > 0 ? values.join(", ") : null;
}

export function displayMetric(value: number | null, unit: string): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(value)} ${unit}`
    : null;
}

function positiveNumericSort(left: number | null, right: number | null): number {
  if (!isPositiveFiniteNumber(left)) {
    return isPositiveFiniteNumber(right) ? 1 : 0;
  }

  if (!isPositiveFiniteNumber(right)) {
    return -1;
  }

  return left - right;
}

function publicationSort(left: SortableResult, right: SortableResult): number {
  const leftPublished = nullableTimestamp(left.publishedAt);
  const rightPublished = nullableTimestamp(right.publishedAt);
  if (leftPublished === null) {
    return rightPublished === null ? timestamp(right.lastSeenAt) - timestamp(left.lastSeenAt) : 1;
  }
  if (rightPublished === null) return -1;
  return rightPublished - leftPublished;
}

function descendingNumericSort(left: number | null, right: number | null): number {
  if (!isFiniteNumber(left)) {
    return isFiniteNumber(right) ? 1 : 0;
  }

  if (!isFiniteNumber(right)) {
    return -1;
  }

  return right - left;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: number | null): value is number {
  return isFiniteNumber(value) && value > 0;
}

function nullableTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
import type { PropertyListingResult } from "@/features/properties/types/property";
