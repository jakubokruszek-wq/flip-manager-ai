import type { CanonicalDeal } from "../types.ts";
import type { BrainConfidenceState, BrainDirector, BrainDirectorId, BrainFreshness, BrainQuestion, BrainRisk, CeoNextBestAction, CeoSynthesis } from "./types.ts";

const FIELD_LABELS: Record<string, string> = {
  legalStatus: "stan prawny", ownership: "forma własności", identity: "tożsamość ogłoszenia", askingPrice: "cena ofertowa",
  marketEvidence: "dowody rynkowe", areaM2: "powierzchnia", rooms: "liczba pokoi", city: "lokalizacja", condition: "stan lokalu",
  renovationScope: "zakres remontu", economics: "walidacja finansowa", riskReview: "przegląd ryzyk", financing: "źródło kapitału",
};

export function synthesizeCeo(deal: CanonicalDeal, directors: Partial<Record<BrainDirectorId, BrainDirector>>, conflicts: BrainRisk[], questions: BrainQuestion[], freshness: BrainFreshness): CeoSynthesis {
  const canonical = deal.ceo.result;
  const underwriting = deal.underwriting.result;
  const gates = canonical?.criticalGates ?? [];
  const openGates = gates.filter((gate) => !gate.passed);
  const hardReject = deal.ceo.vetoes.some((veto) => veto.code === "HARD_REJECT_VETO") || canonical?.decision === "REJECT";
  const blockers = conflicts.filter((risk) => risk.severity === "BLOCKER");
  const upstreamStale = freshness === "STALE" || Object.values(directors).some((director) => director?.freshness === "STALE");
  const decision = decide({ deal, hardReject, openGateCount: openGates.length, blockers, upstreamStale });
  const maxPurchasePrice = underwriting?.maxPurchasePrice ?? canonical?.maxPurchasePrice ?? null;
  const nextBestAction = selectNextAction({ deal, decision, conflicts, questions, maxPurchasePrice, hardReject });
  const topPositiveFactors: string[] = [];
  if (underwriting?.profitBase != null && underwriting.profitBase > 0) topPositiveFactors.push(`Wynik bazowy ${money(underwriting.profitBase)} zł pochodzi z kanonicznego underwritingu.`);
  if (deal.facts.askingPrice.effectiveValue != null && maxPurchasePrice != null && deal.facts.askingPrice.effectiveValue <= maxPurchasePrice) topPositiveFactors.push("Cena ofertowa mieści się w kanonicznym limicie Max Buy.");
  if (deal.market.result && deal.market.result.compCount > 0) topPositiveFactors.push(`Istnieje kanoniczny wynik rynku oparty na ${deal.market.result.compCount} porównaniach.`);
  const topRisks = conflicts.slice(0, 4).map((risk) => risk.explanation);
  const conditionsToProceed = openGates.length
    ? openGates.map((gate) => `Potwierdź: ${FIELD_LABELS[gate.fact] ?? "wymagany dowód"}.`)
    : ["Potwierdź dokumenty i podejmij świadomą decyzję przed zakupem."];
  const walkAwayConditions = [
    ...(maxPurchasePrice == null ? ["Nie składaj wiążącej oferty bez kanonicznego limitu zakupu."] : [`Nie kupuj powyżej kanonicznego limitu ${money(maxPurchasePrice)} zł.`]),
    ...(hardReject ? ["Decyzja odrzucenia jest nadrzędna i nie może zostać cofnięta przez scoring."] : []),
    ...blockers.map((risk) => `Nie kontynuuj, dopóki nie zostanie rozwiązane: ${risk.title.toLowerCase()}.`),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const headline = headlineFor(decision);
  const reasoningSummary = hardReject
    ? "Zachowano nadrzędny twardy lub ręczny powód odrzucenia; wynik punktowy nie może go odwrócić."
    : blockers.length
      ? `Ekonomika nie usuwa blokady. Otwarte blokery: ${blockers.map((risk) => risk.title.toLowerCase()).join("; ")}.`
      : openGates.length
        ? `Kanoniczna analiza nie spełnia ${openGates.length} krytycznych warunków. Brain porządkuje przyczyny, nie zmienia bramek.`
        : "Decyzja syntetyzuje zapisane wyniki dyrektorów i istniejącą decyzję kanoniczną; nie wykonuje nowej kalkulacji.";
  const confidenceState = ceoConfidence(freshness, blockers, questions, deal, directors);

  return {
    decision,
    headline,
    reasoningSummary,
    topPositiveFactors,
    topRisks,
    blockingIssues: blockers.map((risk) => risk.explanation),
    maxPurchasePrice,
    nextBestAction,
    questionsBlockingDecision: questions.filter((question) => question.category === "BLOCKING").map((question) => question.id),
    confidenceState,
    conditionsToProceed,
    walkAwayConditions,
    humanApprovalRequired: true,
    autonomousPurchaseAllowed: false,
  };
}

function decide(input: { deal: CanonicalDeal; hardReject: boolean; openGateCount: number; blockers: BrainRisk[]; upstreamStale: boolean }): CeoSynthesis["decision"] {
  const canonical = input.deal.ceo.result;
  if (input.hardReject) return "REJECT";
  if (input.upstreamStale) return "VERIFY";
  if (canonical?.action === "NEGOCJUJ" && input.deal.underwriting.result?.maxPurchasePrice != null) return "NEGOTIATE";
  if (canonical?.action === "KUP" && input.openGateCount === 0 && input.blockers.length === 0 && input.deal.ceo.status === "COMPLETE" && input.deal.ceo.validation.status === "PASS") return "BUY";
  if (input.openGateCount > 0 || input.blockers.length > 0 || input.deal.verify.status !== "COMPLETE" || input.deal.market.status !== "COMPLETE") return "VERIFY";
  if (canonical?.action === "JEDŹ OBEJRZEĆ") return "VERIFY";
  return "WAIT";
}

function selectNextAction(input: { deal: CanonicalDeal; decision: CeoSynthesis["decision"]; conflicts: BrainRisk[]; questions: BrainQuestion[]; maxPurchasePrice: number | null; hardReject: boolean }): CeoNextBestAction {
  const provenance = input.deal.ceo.provenance.map((item) => ({ sourcePath: `ceo.provenance.${item.field}`, sourceId: item.evidenceId ?? item.sourceId ?? null, classification: item.classification ?? null, evidenceState: item.evidenceId || item.sourceId ? "PRESENT" as const : "MISSING" as const, observedAt: item.observedAt ?? null }));
  if (input.hardReject) return { title: "Zachowaj decyzję odrzucenia; nie reaktywuj oferty automatycznie.", reason: "Nadrzędny twardy lub ręczny reject z kanonicznego wyniku.", requestedEvidence: null, sourceDirectors: ["VERIFY", "CEO"], provenance };

  if (input.decision === "NEGOTIATE") {
    const opening = input.deal.ceo.result?.openingOffer;
    const title = opening == null ? "Otwórz negocjacje w granicach kanonicznego limitu zakupu." : `Złóż warunkową ofertę otwierającą ${money(opening)} zł; nie przekraczaj Max Buy.`;
    return { title, reason: "Działanie NEGOTIATE i kwota otwarcia pochodzą z istniejącego CEO/underwritingu.", requestedEvidence: "Aktualna odpowiedź sprzedającego i potwierdzenie ceny.", sourceDirectors: ["UNDERWRITER", "ACQUISITION", "CEO"], provenance };
  }

  const blockingQuestion = input.questions.find((question) => question.category === "BLOCKING");
  if (blockingQuestion) return { title: blockingQuestion.question, reason: blockingQuestion.whyItMatters, requestedEvidence: blockingQuestion.evidenceNeeded, sourceDirectors: blockingQuestion.requestingDirectors, provenance: [...provenance, { sourcePath: `questions.${blockingQuestion.field}`, sourceId: blockingQuestion.id, classification: null, evidenceState: "MISSING", observedAt: input.deal.updatedAt }] };

  if (input.decision === "BUY") return { title: "Sprawdź dokumenty transakcyjne i zatwierdź zakup świadomie.", reason: "Wszystkie zapisane bramki kanoniczne przeszły; system nie dokonuje zakupu za człowieka.", requestedEvidence: null, sourceDirectors: ["VERIFY", "RISK_LEGAL", "ACQUISITION", "CEO"], provenance };
  if (input.decision === "REJECT") return { title: "Nie kontynuuj zakupu tej oferty.", reason: "Kanoniczny twardy warunek odrzucenia jest nadrzędny.", requestedEvidence: null, sourceDirectors: ["VERIFY", "CEO"], provenance };

  const usefulQuestion = input.questions[0];
  if (usefulQuestion) return { title: usefulQuestion.question, reason: usefulQuestion.whyItMatters, requestedEvidence: usefulQuestion.evidenceNeeded, sourceDirectors: usefulQuestion.requestingDirectors, provenance };
  return { title: input.maxPurchasePrice == null ? "Uzupełnij dane potrzebne do wiarygodnej analizy." : "Odśwież analizę po istotnej zmianie danych.", reason: "Brak jednoznacznego, ważniejszego działania z aktualnych dowodów.", requestedEvidence: null, sourceDirectors: ["VERIFY", "CEO"], provenance };
}

function ceoConfidence(freshness: BrainFreshness, blockers: BrainRisk[], questions: BrainQuestion[], deal: CanonicalDeal, directors: Partial<Record<BrainDirectorId, BrainDirector>>): BrainConfidenceState {
  if (freshness === "STALE" || Object.values(directors).some((director) => director?.freshness === "STALE")) return "UNKNOWN";
  if (blockers.length || questions.some((question) => question.category === "BLOCKING") || deal.ceo.validation.status !== "PASS") return "LIMITED_EVIDENCE";
  if (deal.market.result?.fallbackLevel || deal.market.result?.priceEvidenceType === "USER_ASSUMPTION" || deal.underwriting.result?.provenance.renovationPerM2 === "USER_ASSUMPTION") return "EVIDENCE_WITH_ASSUMPTIONS";
  return freshness === "CURRENT" ? "STRONG_EVIDENCE" : "UNKNOWN";
}

function headlineFor(decision: CeoSynthesis["decision"]): string {
  switch (decision) {
    case "BUY": return "Warunki kanonicznej analizy są spełnione";
    case "NEGOTIATE": return "Ekonomika wskazuje negocjacje";
    case "VERIFY": return "Najpierw potwierdź brakujące dowody";
    case "WAIT": return "Wstrzymaj decyzję do czasu zmiany danych";
    case "REJECT": return "Oferta pozostaje odrzucona";
  }
}

function money(value: number): string { return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value); }
