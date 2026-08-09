import type { RenovationLevel, RenovationOption, RenovationStyle } from "@/features/renovation-visualizer/types";

export type RenovationEstimateItem = {
  name: string;
  min: number;
  max: number;
};

export type RenovationEstimateCategory = {
  name: string;
  min: number;
  max: number;
  description: string;
  items: RenovationEstimateItem[];
};

export type RenovationEstimate = {
  tier: RenovationCostTier;
  area: number;
  rateMin: number;
  rateMax: number;
  totalMin: number;
  totalMax: number;
  estimatedBudget: number;
  userBudget: number;
  budgetDifference: number;
  confidence: number;
  categories: RenovationEstimateCategory[];
  timelineDaysMin: number;
  timelineDaysMax: number;
  warnings: string[];
};

export type RenovationEstimateInput = {
  tier: RenovationCostTier;
  area: number | null;
  renovationLevel: RenovationLevel;
  style: RenovationStyle;
  budget: number;
  options: RenovationOption[];
  propertyContext: {
    rooms?: number | null;
    buildingType?: string | null;
  };
  visualizationConfidence?: number;
};

export type RenovationCostTier = "economy" | "standard" | "premium";

export type RenovationCategoryKey =
  | "demolition"
  | "walls"
  | "painting"
  | "floors"
  | "electrical"
  | "plumbing"
  | "kitchen"
  | "bathroom"
  | "doors"
  | "lighting"
  | "furniture"
  | "carpentry"
  | "reserve";
