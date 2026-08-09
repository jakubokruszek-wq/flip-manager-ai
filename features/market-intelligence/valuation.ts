import type { PriceStatistics } from "./types";

export type RenovationValuation = {
  estimatedAfterRenovationPrice: number | null;
  estimatedAfterRenovationPricePerSqm: number | null;
  estimatedValueIncrease: number | null;
};

export function estimateAfterRenovationValue(
  currentPrice: number | null,
  area: number | null,
  statistics: PriceStatistics,
): RenovationValuation {
  const estimatedAfterRenovationPricePerSqm = statistics.q3 ?? statistics.median ?? statistics.average;
  const estimatedAfterRenovationPrice =
    estimatedAfterRenovationPricePerSqm !== null && isPositiveFinite(area)
      ? estimatedAfterRenovationPricePerSqm * area
      : null;

  return {
    estimatedAfterRenovationPrice,
    estimatedAfterRenovationPricePerSqm,
    estimatedValueIncrease:
      estimatedAfterRenovationPrice !== null && isPositiveFinite(currentPrice)
        ? estimatedAfterRenovationPrice - currentPrice
        : null,
  };
}

function isPositiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
