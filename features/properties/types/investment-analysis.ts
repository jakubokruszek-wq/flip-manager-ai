import type { PropertyAnalysis, FlipScoreResult } from "./property";
import type { MarketIntelligence } from "@/features/market-intelligence/types";
import type { PurchaseRecommendation } from "@/features/purchase-recommendation/types";

export type InvestmentCalculatorSnapshot = {
  purchasePrice: number;
  purchaseTax: number;
  notaryCost: number;
  purchaseCommission: number;
  renovationCost: number;
  furnishingCost: number;
  reserveCost: number;
  salePrice: number;
  saleCommission: number;
  taxCost: number;
  purchaseCost: number;
  totalCost: number;
  revenue: number;
  profit: number;
  roi: number;
  margin: number;
};

export type PropertyInvestmentAnalysis = {
  flipScore: FlipScoreResult;
  aiAnalysis: PropertyAnalysis;
  marketIntelligence: MarketIntelligence;
  purchaseRecommendation: PurchaseRecommendation;
  calculator: InvestmentCalculatorSnapshot;
  analyzedAt: string;
};

export type PropertyWithInvestmentAnalysis = import("./property").Property & {
  investmentAnalysis: PropertyInvestmentAnalysis | null;
};
