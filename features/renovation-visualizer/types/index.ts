export const RENOVATION_STYLES = ["flip-signature", "modern", "japandi", "scandinavian", "loft", "premium", "flip-budget", "luxury"] as const;
export const RENOVATION_LEVELS = ["refresh", "standard", "general"] as const;
export const RENOVATION_BUDGETS = [20_000, 40_000, 60_000, 80_000, 100_000, 150_000] as const;
export const RENOVATION_OPTION_KEYS = ["floors", "doors", "kitchen", "bathroom", "lighting", "furniture", "carpentry", "decorations", "preserve-layout"] as const;

export type RenovationStyle = (typeof RENOVATION_STYLES)[number];
export type RenovationLevel = (typeof RENOVATION_LEVELS)[number];
export type RenovationOption = (typeof RENOVATION_OPTION_KEYS)[number];

export type RenovationVisualizationInput = {
  propertyId: string;
  imageUrl: string;
  style: RenovationStyle;
  renovationLevel: RenovationLevel;
  budget: number;
  options: RenovationOption[];
  instructions: string;
};

export type RenovationVisualizationOutput = {
  generatedImageUrl: string;
  imageDataUrl?: string;
  changes: string[];
  estimatedRenovationMin: number;
  estimatedRenovationMax: number;
  confidence: number;
  warnings: string[];
};

export type RenovationVisualizerApiResponse =
  | { ok: true; result: RenovationVisualizationOutput }
  | { ok: false; code: "INVALID_INPUT" | "MISSING_API_KEY" | "IMAGE_FETCH_FAILED" | "TIMEOUT" | "OPENAI_API_ERROR" | "GENERATION_FAILED"; message: string };
