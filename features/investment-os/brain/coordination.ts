import type { CanonicalDeal } from "../types.ts";
import { DEAL_BRAIN_DEPENDENCIES, dealBrainEdges } from "./dependency-graph.ts";
import type { BrainDirector, BrainDirectorId, CoordinationEvent, CoordinationEventType } from "./types.ts";

export function buildCoordinationEvents(deal: CanonicalDeal, directors: Record<BrainDirectorId, BrainDirector>): CoordinationEvent[] {
  return dealBrainEdges().map((edge) => {
    const source = directors[edge.from];
    const type = eventType(edge.from, edge.to, directors);
    const ready = source.status === "READY" && source.freshness === "CURRENT";
    return {
      id: `brain-flow:${deal.id}:${edge.from}:${edge.to}`,
      from: edge.from,
      to: edge.to,
      type,
      state: ready ? "DELIVERED" : "WAITING_FOR_INPUT",
      subject: ready ? deliveredSubject(type) : waitingSubject(source),
      provenance: source.provenance,
    };
  });
}

export function dependencyDefinitions() { return DEAL_BRAIN_DEPENDENCIES; }

function eventType(from: BrainDirectorId, to: BrainDirectorId, directors: Record<BrainDirectorId, BrainDirector>): CoordinationEventType {
  if (to === "CEO") return "CEO_SYNTHESIS_AVAILABLE";
  if (from === "SCOUT" && to === "VERIFY") return "LISTING_PROFILE_AVAILABLE";
  if (from === "VERIFY" && to === "MARKET") return "FACT_CHECK_AVAILABLE";
  if (from === "MARKET" && to === "UNDERWRITER") return directors.MARKET.status === "READY" ? "EXIT_VALUE_ESTIMATE_AVAILABLE" : "EXIT_VALUE_UNAVAILABLE";
  if (from === "VERIFY" && to === "RENOVATION") return directors.RENOVATION.status === "READY" ? "RENOVATION_ESTIMATE_AVAILABLE" : "RENOVATION_ESTIMATE_UNCERTAIN";
  if (from === "RENOVATION" && to === "UNDERWRITER") return directors.RENOVATION.status === "READY" ? "RENOVATION_ESTIMATE_AVAILABLE" : "RENOVATION_ESTIMATE_UNCERTAIN";
  if (from === "UNDERWRITER" && to === "CFO") return "UNDERWRITING_AVAILABLE";
  if (from === "UNDERWRITER" && to === "ACQUISITION") return directors.UNDERWRITER.metrics.some((metric) => metric.key === "maxPurchasePrice" && metric.value != null) ? "MAX_BUY_AVAILABLE" : "UNDERWRITING_AVAILABLE";
  if (from === "RISK_LEGAL" && to === "ACQUISITION") return directors.RISK_LEGAL.status === "BLOCKED" ? "LEGAL_EVIDENCE_BLOCKER" : "ACQUISITION_ACTION_AVAILABLE";
  if (from === "MARKET" && to === "SALE") return "SALE_RANGE_AVAILABLE";
  if (from === "VERIFY" && to === "RENOVATION") return "RENOVATION_ESTIMATE_UNCERTAIN";
  if (from === "VERIFY" && to === "UNDERWRITER") return "FACT_CHECK_AVAILABLE";
  return "ACQUISITION_ACTION_AVAILABLE";
}

function deliveredSubject(type: CoordinationEventType): string {
  switch (type) {
    case "LISTING_PROFILE_AVAILABLE": return "Zapisany profil oferty przekazany do weryfikacji.";
    case "FACT_CHECK_AVAILABLE": return "Wynik weryfikacji faktów jest dostępny.";
    case "EXIT_VALUE_ESTIMATE_AVAILABLE": return "Kanoniczny przedział wyjścia dostępny dla underwritingu.";
    case "EXIT_VALUE_UNAVAILABLE": return "Wartość wyjścia nie jest dostępna; dalsza ekonomika pozostaje ograniczona.";
    case "RENOVATION_ESTIMATE_AVAILABLE": return "Koszt remontu z kanonicznego modelu jest dostępny.";
    case "RENOVATION_ESTIMATE_UNCERTAIN": return "Szacunek remontu wymaga potwierdzenia stanu lub zakresu prac.";
    case "UNDERWRITING_AVAILABLE": return "Kanoniczny wynik finansowy dostępny do interpretacji.";
    case "MAX_BUY_AVAILABLE": return "Kanoniczny limit Max Buy dostępny dla decyzji zakupowej.";
    case "LEGAL_EVIDENCE_BLOCKER": return "Bramka prawna oczekuje na dowód.";
    case "ACQUISITION_ACTION_AVAILABLE": return "Warunkowe działanie zakupowe jest dostępne.";
    case "SALE_RANGE_AVAILABLE": return "Przedział wyjścia przekazany do oceny sprzedaży.";
    case "CEO_SYNTHESIS_AVAILABLE": return "Synteza CEO korzysta z aktualnego wyniku tej gałęzi.";
  }
}

function waitingSubject(source: BrainDirector): string {
  if (source.freshness === "STALE") return `Wynik ${source.id} jest nieaktualny; zależny wniosek wymaga odświeżenia.`;
  if (source.status === "BLOCKED") return `Wynik ${source.id} jest zablokowany przez brak lub konflikt dowodu.`;
  if (source.status === "NEEDS_DATA") return `Wynik ${source.id} czeka na dane: ${source.missingInputs.join(", ") || "wymagane wejścia"}.`;
  return `Aktualność wyniku ${source.id} nie jest potwierdzona.`;
}
