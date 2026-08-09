export type PurchaseRecommendationInput = {
  estimatedAfterRenovationPrice: number | null;
  renovationCost: number | null;
  furnishingCost: number | null;
  reserveCost: number | null;
  notaryCost: number | null;
  purchaseCommission: number | null;
  saleCommission: number | null;
  taxCost: number | null;
  targetProfit: number | null;
  targetRoi: number | null;
  currentListingPrice: number | null;
};

export type PurchaseDecision = "buy" | "negotiate" | "reject";

export type PurchaseRecommendation = {
  maxPriceForTargetProfit: number | null;
  maxPriceForTargetRoi: number | null;
  recommendedMaxPrice: number | null;
  negotiationTarget: number | null;
  currentPriceDifference: number | null;
  currentPriceDifferencePercent: number | null;
  targetProfit: number | null;
  targetRoi: number | null;
  decision: PurchaseDecision;
  reasons: string[];
  risks: string[];
  potentialProfit: number | null;
  potentialRoi: number | null;
};
