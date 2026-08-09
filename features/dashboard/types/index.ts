import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";

export type PurchaseDecision = "buy" | "negotiate" | "reject";

export type DashboardKpis = {
  activeProperties: number;
  newOpportunities24h: number;
  averageFlipScore: number | null;
  averageRoi: number | null;
  potentialProfit: number;
  priceDrops: number;
};

export type DashboardOpportunity = {
  property: PropertyWithInvestmentAnalysis;
  flipScore: number | null;
  roi: number | null;
  potentialProfit: number | null;
  decision: PurchaseDecision | null;
};

export type DashboardScan = {
  id: string;
  source: string;
  startedAt: string;
  status: "running" | "completed" | "failed" | "partial";
  fetched: number;
  newMatches: number;
  priceDrops: number;
  sourceErrors: number;
  errorMessage: string | null;
};

export type DashboardDayPoint = {
  date: string;
  count: number;
};

export type DashboardProfitPoint = {
  propertyId: string;
  label: string;
  profit: number;
};

export type DashboardPriceDrop = {
  listingId: string;
  propertyId: string | null;
  title: string;
  district: string | null;
  imageUrl: string | null;
  previousPrice: number;
  currentPrice: number;
  dropAmount: number;
  droppedAt: string;
};

export type AttentionReason =
  | "missing_analysis"
  | "missing_budget"
  | "stale_analysis"
  | "weak_roi"
  | "removed_listing";

export type DashboardAttentionItem = {
  property: PropertyWithInvestmentAnalysis;
  reasons: AttentionReason[];
};

export type DashboardSummary = {
  generatedAt: string;
  kpis: DashboardKpis;
  topOpportunities: DashboardOpportunity[];
  recentScans: DashboardScan[];
  opportunitiesByDay: DashboardDayPoint[];
  profitByProperty: DashboardProfitPoint[];
  recentPriceDrops: DashboardPriceDrop[];
  attentionItems: DashboardAttentionItem[];
};
