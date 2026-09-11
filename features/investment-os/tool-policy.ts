import type { AnalysisLevel, DirectorName, ToolPolicyStep } from "./types";

export const DIRECTOR_TOOL_POLICIES: Record<DirectorName, ToolPolicyStep[]> = {
  SCOUT: [
    { order: 1, tool: "INTERNAL_DATABASE", purpose: "Load canonical listing facts and history", minimumLevel: 0, required: true },
  ],
  VERIFY: [
    { order: 1, tool: "INTERNAL_DATABASE", purpose: "Cross-check stored facts and exact source identity", minimumLevel: 0, required: true },
    { order: 2, tool: "DOCUMENT_ANALYSIS", purpose: "Verify ownership and legal facts from supplied primary documents", minimumLevel: 2, required: false },
  ],
  MARKET: [
    { order: 1, tool: "COMPARABLE_ANALYSIS", purpose: "Use high-quality internal comparable evidence", minimumLevel: 1, required: true },
    { order: 2, tool: "CURRENT_RESEARCH", purpose: "Obtain current public market evidence when internal evidence is insufficient", minimumLevel: 2, required: false },
    { order: 3, tool: "HISTORICAL_MODEL", purpose: "Use closed-deal outcomes for calibration", minimumLevel: 2, required: false },
    { order: 4, tool: "INTERNAL_DATABASE", purpose: "Use explicit versioned market assumptions as a disclosed fallback", minimumLevel: 1, required: false },
  ],
  UNDERWRITER: [
    { order: 1, tool: "DETERMINISTIC_ENGINE", purpose: "Calculate scenarios, costs, thresholds and maximum purchase price", minimumLevel: 1, required: true },
    { order: 2, tool: "INDEPENDENT_VALIDATOR", purpose: "Validate threshold invariants without trusting the director result", minimumLevel: 1, required: true },
  ],
  CEO: [
    { order: 1, tool: "INDEPENDENT_VALIDATOR", purpose: "Consume only validated director outputs and enforce vetoes", minimumLevel: 1, required: true },
    { order: 2, tool: "HISTORICAL_MODEL", purpose: "Consider calibrated director track records when outcomes exist", minimumLevel: 2, required: false },
  ],
};

export function policyFor(director: DirectorName, level: AnalysisLevel): ToolPolicyStep[] {
  return DIRECTOR_TOOL_POLICIES[director].filter((step) => step.minimumLevel <= level).sort((left, right) => left.order - right.order);
}
