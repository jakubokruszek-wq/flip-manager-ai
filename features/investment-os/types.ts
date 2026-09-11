import type { UnderwritingResult, UnderwritingSettings, ValueProvenance } from "../flip-finder/underwriting.ts";

export const DIRECTOR_STATUSES = ["NOT_RUN", "READY", "RUNNING", "COMPLETE", "STALE", "BLOCKED", "FAILED"] as const;
export type DirectorStatus = (typeof DIRECTOR_STATUSES)[number];
export type DirectorName = "SCOUT" | "VERIFY" | "MARKET" | "UNDERWRITER" | "CEO";
export type DealStage = "DISCOVERED" | "VERIFYING" | "VERIFIED" | "MARKET_READY" | "UNDERWRITTEN" | "DECISION_READY" | "ACQUISITION" | "RENOVATION" | "SALE" | "CLOSED";

export type ProvenanceEntry = { field: string; provenance: ValueProvenance; sourceId?: string | null };
export type DirectorOutput<T> = {
  director: DirectorName;
  status: DirectorStatus;
  version: number;
  inputFingerprint: string;
  computedAt: string;
  confidence: number;
  result: T | null;
  missingFields: string[];
  warnings: string[];
  reasonCodes: string[];
  provenance: ProvenanceEntry[];
  finding: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  missingData: string[];
  nextBestActions: string[];
  decisionTriggers: string[];
  whatWouldChangeMyMind: string[];
};

export type FactValue<T> = {
  sourceValue: T | null;
  overrideValue: T | null;
  effectiveValue: T | null;
  provenance: ValueProvenance;
  confidence: number;
};

export type DealFacts = {
  city: FactValue<string>; district: FactValue<string>; street: FactValue<string>;
  areaM2: FactValue<number>; rooms: FactValue<number>; floor: FactValue<string>; floorsTotal: FactValue<string>;
  buildingType: FactValue<string>; yearBuilt: FactValue<number>; ownership: FactValue<string>; condition: FactValue<string>;
  monthlyFee: FactValue<number>; askingPrice: FactValue<number>; askingPricePerM2: FactValue<number>;
  source: FactValue<string>; sourceUrl: FactValue<string>; postId: FactValue<string>;
  galleryStatus: FactValue<string>; imageCount: FactValue<number>;
};

export type VerifyResult = {
  verificationStatus: "VERIFIED" | "INCOMPLETE";
  verifiedFacts: string[];
  missingCriticalFields: string[];
  missingOptionalFields: string[];
  conflicts: string[];
};

export type MarketResult = {
  resalePricePerM2Low: number;
  resalePricePerM2Base: number;
  resalePricePerM2High: number;
  resaleValueLow: number;
  resaleValueBase: number;
  resaleValueHigh: number;
  assumptionMatchedBy: string;
  assumptionId: string | null;
  compCount: number;
};

export type CeoResult = {
  decision: "HOT" | "GOOD" | "REVIEW" | "TOO_EXPENSIVE" | "REJECT";
  action: "KUP" | "NEGOCJUJ" | "JEDŹ OBEJRZEĆ" | "HOLD / ZBIERZ DANE" | "ODRZUĆ";
  headline: string;
  openingOffer: number | null;
  targetPurchasePrice: number | null;
  maxPurchasePrice: number | null;
  expectedProfitBase: number | null;
  expectedProfitConservative: number | null;
  flipScore: number;
  confidence: number;
  strengths: string[];
  risks: string[];
  missingBeforeViewing: string[];
  missingBeforePurchase: string[];
  recommendation: string;
  investmentThesis: string;
  bearCase: string;
  baseCase: string;
  bullCase: string;
  dissent: string[];
  conditionsToProceed: string[];
  walkAwayConditions: string[];
  nextBestAction: string;
};

export type DealPlaybook = {
  beforeCall: string[];
  sellerQuestions: string[];
  viewingChecklist: string[];
  negotiationPlan: string[];
  documentsRequired: string[];
  conditionsBeforePurchase: string[];
};

export type CanonicalDeal = {
  id: string;
  listingId: string;
  stage: DealStage;
  factsFingerprint: string;
  facts: DealFacts;
  scout: DirectorOutput<{ listingId: string; source: string | null; sourceUrl: string | null; lifecycleStatus: string | null }>;
  verify: DirectorOutput<VerifyResult>;
  market: DirectorOutput<MarketResult>;
  underwriting: DirectorOutput<UnderwritingResult>;
  ceo: DirectorOutput<CeoResult>;
  playbook: DealPlaybook;
  createdAt: string;
  updatedAt: string;
};

export type DealFactOverrides = Partial<Record<keyof DealFacts, string | number | null>> & {
  resalePerM2?: number | null;
  renovationPerM2?: number | null;
  holdingMonths?: number | null;
  additionalCosts?: number | null;
};

export type MarketEvidence = {
  id: string | null;
  matchedBy: string;
  low: number;
  base: number;
  high: number;
  confidence: number;
  provenance: "DERIVED" | "USER_ASSUMPTION" | "MARKET_ASSUMPTION";
  compCount: number;
};

export type DealListingInput = {
  id: string; source: string; sourceUrl: string; externalListingId: string | null;
  lifecycleStatus: string | null; decisionBucket: "MATCHED" | "REVIEW" | "REJECTED";
  manualDecision: "ACCEPTED" | "REJECTED" | null;
  city: string | null; district: string | null; street: string | null;
  areaM2: number | null; rooms: number | null; floor: string | null; floorsTotal: string | null;
  buildingType: string | null; yearBuilt: number | null; ownership: string | null; condition: string | null;
  monthlyFee: number | null; askingPrice: number | null; askingPricePerM2: number | null;
  galleryStatus: string | null; imageCount: number; identityExact: boolean;
};

export type BuildDealInput = {
  dealId: string;
  listing: DealListingInput;
  overrides: DealFactOverrides;
  market: MarketEvidence | null;
  settings: UnderwritingSettings;
  now: string;
  createdAt?: string;
};
