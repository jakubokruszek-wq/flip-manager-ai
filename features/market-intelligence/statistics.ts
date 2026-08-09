import type { PriceStatistics } from "./types";

export function calculatePriceStatistics(values: number[]): PriceStatistics {
  const sorted = values.filter(isPositiveFinite).sort((left, right) => left - right);

  if (sorted.length === 0) {
    return { average: null, median: null, min: null, max: null, q1: null, q3: null, standardDeviation: null };
  }

  const average = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance = sorted.reduce((total, value) => total + (value - average) ** 2, 0) / sorted.length;

  return {
    average,
    median: quantile(sorted, 0.5),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    standardDeviation: Math.sqrt(variance),
  };
}

export function average(values: Array<number | null>): number | null {
  const valid = values.filter(isPositiveFinite);
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null;
}

export function percentileRank(values: number[], value: number | null): number | null {
  const valid = values.filter(isPositiveFinite);
  if (!isPositiveFinite(value) || valid.length === 0) return null;
  return (valid.filter((item) => item <= value).length / valid.length) * 100;
}

function quantile(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function isPositiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
