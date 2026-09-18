import type { CanonicalDeal, EvidenceClass, InformationRequest } from "../types.ts";

export const BRAIN_DIRECTORS = [
  "SCOUT",
  "VERIFY",
  "MARKET",
  "RENOVATION",
  "UNDERWRITER",
  "RISK_LEGAL",
  "CFO",
  "ACQUISITION",
  "SALE",
  "CEO",
] as const;

export type BrainDirectorId = (typeof BRAIN_DIRECTORS)[number];
export type BrainDirectorStatus = "READY" | "NEEDS_DATA" | "BLOCKED" | "NOT_APPLICABLE";
export type BrainFreshness = "CURRENT" | "STALE" | "UNKNOWN";
export type BrainConfidenceState = "STRONG_EVIDENCE" | "EVIDENCE_WITH_ASSUMPTIONS" | "LIMITED_EVIDENCE" | "UNKNOWN";
export type BrainRiskCategory = "LEGAL" | "DATA" | "MARKET" | "RENOVATION" | "FINANCIAL" | "LIQUIDITY" | "EXECUTION";
export type BrainRiskSeverity = "INFO" | "WATCH" | "MATERIAL" | "BLOCKER";
export type BrainQuestionCategory = "BLOCKING" | "DECISION_CHANGING" | "USEFUL";
export type BrainDecision = "BUY" | "NEGOTIATE" | "VERIFY" | "WAIT" | "REJECT";

export type BrainProvenance = {
  sourcePath: string;
  sourceId: string | null;
  classification: EvidenceClass | null;
  evidenceState: "PRESENT" | "ASSUMPTION" | "MISSING";
  observedAt: string | null;
};

export type BrainMetric = {
  key: string;
  label: string;
  value: string | number | boolean | null;
  unit?: "PLN" | "PLN_PER_M2" | "M2" | "ROOMS" | "COUNT" | "PERCENT";
  provenance: BrainProvenance;
};

export type BrainRisk = {
  id: string;
  type: string;
  category: BrainRiskCategory;
  severity: BrainRiskSeverity;
  title: string;
  explanation: string;
  sourceDirector: BrainDirectorId;
  directorsInvolved: BrainDirectorId[];
  provenance: BrainProvenance[];
  resolutionRequired: boolean;
};

export type BrainDirector = {
  id: BrainDirectorId;
  status: BrainDirectorStatus;
  headline: string;
  summary: string;
  finding: string;
  recommendation: string;
  metrics: BrainMetric[];
  confidenceState: BrainConfidenceState;
  evidence: BrainProvenance[];
  dependencies: BrainDirectorId[];
  missingInputs: string[];
  warnings: string[];
  questionFields: string[];
  provenance: BrainProvenance[];
  freshness: BrainFreshness;
  generatedFrom: {
    dealId: string;
    factsFingerprint: string;
    outputFingerprint: string | null;
    sourceUpdatedAt: string;
  };
  risks: BrainRisk[];
};

export type BrainDependencyDefinition = {
  director: BrainDirectorId;
  dependsOnDirectors: BrainDirectorId[];
  dependsOnFields: string[];
  rationale: string;
};

export type BrainDependencyEdge = {
  from: BrainDirectorId;
  to: BrainDirectorId;
  fields: string[];
};

export type CoordinationEventType =
  | "LISTING_PROFILE_AVAILABLE"
  | "FACT_CHECK_AVAILABLE"
  | "EXIT_VALUE_ESTIMATE_AVAILABLE"
  | "EXIT_VALUE_UNAVAILABLE"
  | "RENOVATION_ESTIMATE_AVAILABLE"
  | "RENOVATION_ESTIMATE_UNCERTAIN"
  | "UNDERWRITING_AVAILABLE"
  | "MAX_BUY_AVAILABLE"
  | "LEGAL_EVIDENCE_BLOCKER"
  | "ACQUISITION_ACTION_AVAILABLE"
  | "SALE_RANGE_AVAILABLE"
  | "CEO_SYNTHESIS_AVAILABLE";

export type CoordinationEvent = {
  id: string;
  from: BrainDirectorId;
  to: BrainDirectorId;
  type: CoordinationEventType;
  state: "DELIVERED" | "WAITING_FOR_INPUT";
  subject: string;
  provenance: BrainProvenance[];
};

export type BrainQuestion = {
  id: string;
  field: string;
  category: BrainQuestionCategory;
  priority: InformationRequest["priority"];
  question: string;
  whyItMatters: string;
  requestingDirectors: BrainDirectorId[];
  affectedDecision: InformationRequest["decisionImpact"];
  affectedMetrics: string[];
  evidenceNeeded: string;
  valueOfInformation: number | null;
};

export type CeoNextBestAction = {
  title: string;
  reason: string;
  requestedEvidence: string | null;
  sourceDirectors: BrainDirectorId[];
  provenance: BrainProvenance[];
};

export type CeoSynthesis = {
  decision: BrainDecision;
  headline: string;
  reasoningSummary: string;
  topPositiveFactors: string[];
  topRisks: string[];
  blockingIssues: string[];
  maxPurchasePrice: number | null;
  nextBestAction: CeoNextBestAction;
  questionsBlockingDecision: string[];
  confidenceState: BrainConfidenceState;
  conditionsToProceed: string[];
  walkAwayConditions: string[];
  humanApprovalRequired: true;
  autonomousPurchaseAllowed: false;
};

export type CanonicalFinancialSnapshot = {
  purchasePrice: number | null;
  renovationTotal: number | null;
  totalProjectCost: number | null;
  profitLow: number | null;
  profitBase: number | null;
  profitHigh: number | null;
  marginBase: number | null;
  roiBase: number | null;
  maxPurchasePrice: number | null;
  targetPurchasePrice: number | null;
  scenarios: NonNullable<CanonicalDeal["underwriting"]["result"]>["scenarios"] | null;
  buyGate: NonNullable<CanonicalDeal["ceo"]["result"]>["criticalGates"];
  sourceOutputFingerprint: string;
};

export type BrainSnapshot = {
  schemaVersion: 1;
  dealId: string;
  generatedFrom: {
    dealId: string;
    factsFingerprint: string;
    sourceUpdatedAt: string;
    sourceOutputFingerprints: Partial<Record<BrainDirectorId, string>>;
  };
  freshness: BrainFreshness;
  directors: Record<BrainDirectorId, BrainDirector>;
  directorOrder: readonly BrainDirectorId[];
  dependencyGraph: {
    nodes: readonly BrainDependencyDefinition[];
    edges: BrainDependencyEdge[];
  };
  coordinationEvents: CoordinationEvent[];
  conflicts: BrainRisk[];
  questions: BrainQuestion[];
  topQuestions: BrainQuestion[];
  ceo: CeoSynthesis;
  financials: CanonicalFinancialSnapshot | null;
};
