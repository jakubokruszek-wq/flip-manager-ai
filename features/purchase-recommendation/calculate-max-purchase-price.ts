import type { PurchaseRecommendationInput } from "./types";

export type PurchasePriceLimits = {
  maxPriceForTargetProfit: number | null;
  maxPriceForTargetRoi: number | null;
  potentialProfit: number | null;
  potentialRoi: number | null;
};

export function calculatePurchasePriceLimits(input: PurchaseRecommendationInput): PurchasePriceLimits {
  const saleRevenue = saleRevenueAfterCosts(input);
  const nonPurchaseCosts = nonPurchaseCostsTotal(input);
  const targetProfit = nonNegative(input.targetProfit);
  const targetRoi = nonNegative(input.targetRoi);
  const currentListingPrice = nonNegative(input.currentListingPrice);

  const maxPriceForTargetProfit =
    saleRevenue !== null && targetProfit !== null
      ? nonNegativeResult(saleRevenue - nonPurchaseCosts - targetProfit)
      : null;
  const roiRate = targetRoi === null ? null : targetRoi / 100;
  const maxPriceForTargetRoi =
    saleRevenue !== null && roiRate !== null
      ? nonNegativeResult(saleRevenue / (1 + roiRate) - nonPurchaseCosts)
      : null;
  const potentialProfit =
    saleRevenue !== null && currentListingPrice !== null
      ? saleRevenue - nonPurchaseCosts - currentListingPrice
      : null;
  const potentialRoi =
    potentialProfit !== null && currentListingPrice !== null && currentListingPrice + nonPurchaseCosts > 0
      ? (potentialProfit / (currentListingPrice + nonPurchaseCosts)) * 100
      : null;

  return { maxPriceForTargetProfit, maxPriceForTargetRoi, potentialProfit, potentialRoi };
}

function saleRevenueAfterCosts(input: PurchaseRecommendationInput): number | null {
  const estimatedAfterRenovationPrice = nonNegative(input.estimatedAfterRenovationPrice);
  return estimatedAfterRenovationPrice === null
    ? null
    : estimatedAfterRenovationPrice - valueOrZero(input.saleCommission) - valueOrZero(input.taxCost);
}

function nonPurchaseCostsTotal(input: PurchaseRecommendationInput): number {
  return valueOrZero(input.renovationCost) + valueOrZero(input.furnishingCost) + valueOrZero(input.reserveCost) + purchaseCostsTotal(input);
}

function purchaseCostsTotal(input: PurchaseRecommendationInput): number {
  return valueOrZero(input.notaryCost) + valueOrZero(input.purchaseCommission);
}

function nonNegative(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function valueOrZero(value: number | null): number {
  return nonNegative(value) ?? 0;
}

function nonNegativeResult(value: number): number {
  return Math.max(0, value);
}
