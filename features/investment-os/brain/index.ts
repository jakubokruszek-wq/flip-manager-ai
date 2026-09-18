import type { CanonicalDeal } from "../types.ts";
import { buildCoordinationEvents, dependencyDefinitions } from "./coordination.ts";
import { detectBrainConflicts } from "./conflict-engine.ts";
import { dealBrainEdges, topologicalDirectorOrder, validateDealBrainGraph } from "./dependency-graph.ts";
import { buildBaseBrainDirectors, createBrainDirector } from "./director-rules.ts";
import { synthesizeCeo } from "./ceo-synthesis.ts";
import { buildBrainQuestions } from "./question-engine.ts";
import { BRAIN_DIRECTORS, type BrainDirector, type BrainDirectorId, type BrainFreshness, type BrainSnapshot, type CanonicalFinancialSnapshot } from "./types.ts";

export * from "./types.ts";
export { DEAL_BRAIN_DEPENDENCIES, dealBrainEdges, topologicalDirectorOrder, validateDealBrainGraph } from "./dependency-graph.ts";

/**
 * Build a read-only deterministic snapshot from the one canonical deal already in memory.
 * No clock, random value, network call, or persistence path is used here.
 */
export function buildDealBrain(canonicalDeal: CanonicalDeal): BrainSnapshot {
  validateDealBrainGraph();
  const conflicts = detectBrainConflicts(canonicalDeal);
  const partial = buildBaseBrainDirectors(canonicalDeal, conflicts);
  const questions = buildBrainQuestions(canonicalDeal, partial);
  const freshness = aggregateFreshness(Object.values(partial).map((director) => director?.freshness ?? "UNKNOWN"));
  const synthesis = synthesizeCeo(canonicalDeal, partial, conflicts, questions, freshness);
  const ceoFreshness = aggregateFreshness(Object.values(partial).map((director) => director?.freshness ?? "UNKNOWN"));
  const ceoStatus = canonicalDeal.ceo.vetoes.some((veto) => veto.code === "HARD_REJECT_VETO") || conflicts.some((risk) => risk.severity === "BLOCKER")
    ? "BLOCKED"
    : questions.some((question) => question.category === "BLOCKING") || canonicalDeal.ceo.status !== "COMPLETE" || canonicalDeal.ceo.validation.status !== "PASS"
      ? "NEEDS_DATA"
      : "READY";
  const ceoProvenance = [
    ...canonicalDeal.ceo.provenance,
    ...canonicalDeal.market.provenance,
    ...canonicalDeal.underwriting.provenance,
  ].map((item) => ({ sourcePath: `canonical.${item.field}`, sourceId: item.evidenceId ?? item.assumptionId ?? item.sourceId ?? null, classification: item.classification ?? null, evidenceState: item.evidenceId || item.assumptionId || item.sourceId ? (item.classification === "ESTIMATE" || item.classification === "ASSUMPTION" || item.classification === "USER_OVERRIDE" ? "ASSUMPTION" as const : "PRESENT" as const) : "MISSING" as const, observedAt: item.observedAt ?? null }));
  const directorMap: Record<BrainDirectorId, BrainDirector> = {
    ...(partial as Record<Exclude<BrainDirectorId, "CEO">, BrainDirector>),
    CEO: createBrainDirector(canonicalDeal, "CEO", {
      status: ceoStatus,
      headline: synthesis.headline,
      summary: synthesis.reasoningSummary,
      finding: synthesis.reasoningSummary,
      recommendation: synthesis.nextBestAction.title,
      missingInputs: questions.map((question) => question.field),
      warnings: [...conflicts.map((risk) => risk.explanation), ...(freshness === "STALE" ? ["Co najmniej jedna zależna analiza jest nieaktualna."] : [])],
      evidence: ceoProvenance,
      freshness: ceoFreshness,
      risks: conflicts.filter((risk) => risk.directorsInvolved.includes("CEO")),
    }),
  };
  const financials = canonicalFinancials(canonicalDeal);
  const outputFingerprints = sourceFingerprints(canonicalDeal);

  return {
    schemaVersion: 1,
    dealId: canonicalDeal.id,
    generatedFrom: { dealId: canonicalDeal.id, factsFingerprint: canonicalDeal.factsFingerprint, sourceUpdatedAt: canonicalDeal.updatedAt, sourceOutputFingerprints: outputFingerprints },
    freshness: aggregateFreshness([...Object.values(directorMap).map((director) => director.freshness), freshness]),
    directors: directorMap,
    directorOrder: BRAIN_DIRECTORS,
    dependencyGraph: { nodes: dependencyDefinitions(), edges: dealBrainEdges() },
    coordinationEvents: buildCoordinationEvents(canonicalDeal, directorMap),
    conflicts,
    questions,
    topQuestions: questions.slice(0, 3),
    ceo: synthesis,
    financials,
  };
}

function canonicalFinancials(deal: CanonicalDeal): CanonicalFinancialSnapshot | null {
  const result = deal.underwriting.result;
  if (!result) return null;
  return {
    purchasePrice: result.purchasePrice,
    renovationTotal: result.renovationTotal,
    totalProjectCost: result.totalProjectCost,
    profitLow: result.profitLow,
    profitBase: result.profitBase,
    profitHigh: result.profitHigh,
    marginBase: result.marginBase,
    roiBase: result.roiBase,
    maxPurchasePrice: result.maxPurchasePrice,
    targetPurchasePrice: result.targetPurchasePrice,
    scenarios: result.scenarios,
    buyGate: deal.ceo.result?.criticalGates ?? [],
    sourceOutputFingerprint: deal.underwriting.inputFingerprint,
  };
}

function sourceFingerprints(deal: CanonicalDeal): Partial<Record<BrainDirectorId, string>> {
  return {
    SCOUT: deal.scout.inputFingerprint,
    VERIFY: deal.verify.inputFingerprint,
    MARKET: deal.market.inputFingerprint,
    RENOVATION: deal.underwriting.inputFingerprint,
    UNDERWRITER: deal.underwriting.inputFingerprint,
    RISK_LEGAL: deal.ceo.inputFingerprint,
    CFO: deal.underwriting.inputFingerprint,
    ACQUISITION: deal.ceo.inputFingerprint,
    SALE: deal.market.inputFingerprint,
    CEO: deal.ceo.inputFingerprint,
  };
}

function aggregateFreshness(values: BrainFreshness[]): BrainFreshness {
  if (values.includes("STALE")) return "STALE";
  if (values.includes("UNKNOWN")) return "UNKNOWN";
  return "CURRENT";
}
