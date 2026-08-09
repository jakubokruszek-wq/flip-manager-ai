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
  return [...items].sort((left, right) => {
    if (sort === "price_asc") {
      return numericSort(left.price, right.price);
    }

    if (sort === "price_per_sqm_asc") {
      return numericSort(left.pricePerSqm, right.pricePerSqm);
    }

    if (sort === "biggest_price_drop") {
      return descendingNumericSort(left.priceDropAmount, right.priceDropAmount);
    }

    return timestamp(right.lastSeenAt) - timestamp(left.lastSeenAt);
  });
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

function numericSort(left: number | null, right: number | null): number {
  if (!isFiniteNumber(left)) {
    return isFiniteNumber(right) ? 1 : 0;
  }

  if (!isFiniteNumber(right)) {
    return -1;
  }

  return left - right;
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

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
import type { PropertyListingResult } from "@/features/properties/types/property";
