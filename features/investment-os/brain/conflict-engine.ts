import type { CanonicalDeal, EvidenceClass } from "../types.ts";
import type { BrainProvenance, BrainRisk } from "./types.ts";

export function detectBrainConflicts(deal: CanonicalDeal): BrainRisk[] {
  const conflicts: BrainRisk[] = [];
  const underwriting = deal.underwriting.result;
  const ceo = deal.ceo.result;
  const legalGate = ceo?.criticalGates.find((gate) => gate.fact === "legalStatus");
  const legalEvidence = deal.evidenceFabric.filter((item) => item.field === "legalStatus" && item.verificationStatus === "VERIFIED");
  const legalBlocker = Boolean(legalGate && !legalGate.passed && legalEvidence.length === 0);
  const legalProvenance = legalEvidence.length
    ? legalEvidence.map((item) => evidenceProvenance(item.id, item.field ?? "legalStatus", item.sourceName, item.observedAt))
    : [missingProvenance("ceo.result.criticalGates.legalStatus", deal.ceo.computedAt)];

  if (legalBlocker) {
    conflicts.push({
      id: "legal-evidence-missing",
      type: "LEGAL_EVIDENCE_MISSING",
      category: "LEGAL",
      severity: "BLOCKER",
      title: "Brak dowodu wymaganego do potwierdzenia stanu prawnego",
      explanation: "Kanoniczna bramka zakupu wskazuje, że stan prawny nie jest potwierdzony. To nie oznacza wykrytej wady prawnej; oznacza brak podstawy do bezpiecznej decyzji zakupowej.",
      sourceDirector: "RISK_LEGAL",
      directorsInvolved: ["VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"],
      provenance: legalProvenance,
      resolutionRequired: true,
    });
  }

  if ((deal.verify.result?.conflicts.length ?? 0) > 0) {
    conflicts.push({
      id: "material-fact-conflict",
      type: "MATERIAL_FACT_CONFLICT",
      category: "DATA",
      severity: "BLOCKER",
      title: "Nierozstrzygnięty konflikt danych",
      explanation: "Kanoniczna weryfikacja wykryła sprzeczne wartości faktu materialnego. Do czasu rozstrzygnięcia nie należy traktować zależnych wniosków jako potwierdzonych.",
      sourceDirector: "VERIFY",
      directorsInvolved: ["VERIFY", "MARKET", "UNDERWRITER", "RISK_LEGAL", "ACQUISITION", "CEO"],
      provenance: deal.verify.provenance.map((item) => provenance(item.field, item.evidenceId ?? item.sourceId, item.classification ?? null, item.observedAt ?? null)),
      resolutionRequired: true,
    });
  }

  if (legalBlocker && underwriting?.profitBase != null && underwriting.profitBase > 0) {
    conflicts.push({
      id: "positive-economics-legal-blocker",
      type: "POSITIVE_ECONOMICS_WITH_LEGAL_BLOCKER",
      category: "LEGAL",
      severity: "BLOCKER",
      title: "Dodatni scenariusz nie usuwa blokady prawnej",
      explanation: "Kanoniczny scenariusz bazowy pokazuje dodatni wynik, ale istniejąca bramka stanu prawnego nie przeszła. To wymaga dowodu prawnego przed decyzją zakupową.",
      sourceDirector: "RISK_LEGAL",
      directorsInvolved: ["UNDERWRITER", "CFO", "RISK_LEGAL", "ACQUISITION", "CEO"],
      provenance: [...legalProvenance, provenance("underwriting.result.profitBase", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt)],
      resolutionRequired: true,
    });
  }

  const askingPrice = deal.facts.askingPrice.effectiveValue;
  const maxBuy = underwriting?.maxPurchasePrice ?? ceo?.maxPurchasePrice ?? null;
  const failedGates = ceo?.criticalGates.filter((gate) => !gate.passed) ?? [];
  if (askingPrice != null && maxBuy != null && askingPrice <= maxBuy && failedGates.length > 0) {
    conflicts.push({
      id: "price-within-max-buy-unresolved-gates",
      type: "ASKING_WITHIN_MAX_BUY_BUT_GATES_OPEN",
      category: "FINANCIAL",
      severity: "MATERIAL",
      title: "Cena mieści się w limicie, ale bramki pozostają otwarte",
      explanation: "Cena ofertowa nie przekracza kanonicznego limitu zakupu, lecz co najmniej jedna krytyczna bramka nadal wymaga dowodu. Sam limit nie stanowi zgody na zakup.",
      sourceDirector: "ACQUISITION",
      directorsInvolved: ["UNDERWRITER", "RISK_LEGAL", "ACQUISITION", "CEO"],
      provenance: [
        provenance("facts.askingPrice", deal.facts.askingPrice.evidenceId, deal.facts.askingPrice.classification, deal.facts.askingPrice.observedAt),
        provenance("underwriting.result.maxPurchasePrice", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt),
        ...failedGates.map((gate) => missingProvenance(`ceo.result.criticalGates.${gate.fact}`, deal.ceo.computedAt)),
      ],
      resolutionRequired: true,
    });
  }

  const market = deal.market.result;
  if (market && (market.fallbackLevel > 0 || market.compCount === 0 || market.priceEvidenceType === "USER_ASSUMPTION")) {
    conflicts.push({
      id: "market-value-limited-evidence",
      type: "EXIT_VALUE_WITH_LIMITED_MARKET_EVIDENCE",
      category: "MARKET",
      severity: "MATERIAL",
      title: "Wartość wyjścia ma ograniczone potwierdzenie rynkowe",
      explanation: "Wynik wyjścia istnieje, ale kanoniczne źródło wskazuje założenie ręczne, brak porównań albo użycie poziomu zastępczego. Nie należy przedstawiać go jako ceny potwierdzonej transakcjami.",
      sourceDirector: "MARKET",
      directorsInvolved: ["MARKET", "SALE", "UNDERWRITER", "CFO", "CEO"],
      provenance: deal.market.provenance.map((item) => provenance(item.field, item.evidenceId ?? item.sourceId, item.classification ?? null, item.observedAt ?? null)),
      resolutionRequired: true,
    });
  }

  const condition = deal.facts.condition.effectiveValue;
  if (underwriting?.renovationTotal != null && (condition == null || deal.facts.condition.freshness === "STALE")) {
    conflicts.push({
      id: "renovation-estimate-condition-unknown",
      type: "RENOVATION_ESTIMATE_WITHOUT_CURRENT_CONDITION",
      category: "RENOVATION",
      severity: "MATERIAL",
      title: "Koszt remontu opiera się na niepotwierdzonym stanie lokalu",
      explanation: "Kanoniczny model pokazuje koszt remontu, ale stan lokalu nie jest znany albo jest nieaktualny. Kwota pozostaje estymacją modelu, nie kosztorysem po oględzinach.",
      sourceDirector: "RENOVATION",
      directorsInvolved: ["VERIFY", "RENOVATION", "UNDERWRITER", "CFO", "CEO"],
      provenance: [
        condition == null ? missingProvenance("facts.condition", deal.facts.condition.observedAt) : provenance("facts.condition", deal.facts.condition.evidenceId, deal.facts.condition.classification, deal.facts.condition.observedAt),
        provenance("underwriting.result.renovationTotal", `deal:${deal.id}:underwriting`, "ESTIMATE", deal.underwriting.computedAt),
      ],
      resolutionRequired: true,
    });
  }

  return conflicts;
}

function provenance(sourcePath: string, sourceId: string | null | undefined, classification: EvidenceClass | null, observedAt: string | null): BrainProvenance {
  return { sourcePath, sourceId: sourceId ?? null, classification, evidenceState: classification === "ASSUMPTION" || classification === "ESTIMATE" || classification === "USER_OVERRIDE" ? "ASSUMPTION" : sourceId ? "PRESENT" : "MISSING", observedAt };
}

function evidenceProvenance(sourceId: string, field: string, sourceName: string, observedAt: string | null): BrainProvenance {
  return { sourcePath: `evidenceFabric.${field}`, sourceId: `${sourceName}:${sourceId}`, classification: "FACT", evidenceState: "PRESENT", observedAt };
}

function missingProvenance(sourcePath: string, observedAt: string | null): BrainProvenance {
  return { sourcePath, sourceId: null, classification: null, evidenceState: "MISSING", observedAt };
}
