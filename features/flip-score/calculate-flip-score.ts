import { FLIP_SCORE_RULES, isRenovationListing } from "./rules";
import type { FlipScoreInput, FlipScoreLabel, FlipScoreResult } from "./types";

export function calculateFlipScore(input: FlipScoreInput): FlipScoreResult {
  let score = 0;
  const reasons: string[] = [];
  const risks: string[] = [];

  if (input.pricePerSqm === null || input.averagePricePerSqm === null) {
    risks.push("Brak referencyjnej średniej ceny za m².");
  } else if (input.pricePerSqm < input.averagePricePerSqm) {
    score += FLIP_SCORE_RULES.pricePerSqm.below;
    reasons.push("Cena za m² poniżej średniej referencyjnej.");
  } else if (input.pricePerSqm === input.averagePricePerSqm) {
    score += FLIP_SCORE_RULES.pricePerSqm.equal;
    reasons.push("Cena za m² na poziomie średniej referencyjnej.");
  } else {
    score += FLIP_SCORE_RULES.pricePerSqm.above;
    risks.push("Cena za m² powyżej średniej referencyjnej.");
  }

  if (input.rooms !== null && input.rooms >= 2 && input.rooms <= 3) {
    score += FLIP_SCORE_RULES.rooms;
    reasons.push("Optymalna liczba pokoi dla flipa (2–3)." );
  } else if (input.rooms !== null) {
    risks.push("Liczba pokoi poza preferowanym zakresem 2–3.");
  }

  if (input.area !== null && input.area >= 35 && input.area <= 65) {
    score += FLIP_SCORE_RULES.area;
    reasons.push("Metraż w preferowanym zakresie 35–65 m².");
  } else if (input.area !== null) {
    risks.push("Metraż poza preferowanym zakresem 35–65 m².");
  }

  if (input.marketType === "secondary") {
    score += FLIP_SCORE_RULES.secondaryMarket;
    reasons.push("Rynek wtórny zwiększa potencjał negocjacyjny.");
  } else if (input.marketType === "primary") {
    risks.push("Rynek pierwotny ma zwykle mniejszy potencjał negocjacyjny.");
  } else {
    risks.push("Brak informacji o rynku nieruchomości.");
  }

  if (isRenovationListing(input.title, input.description)) {
    score += FLIP_SCORE_RULES.renovation;
    reasons.push("Ogłoszenie wskazuje na nieruchomość do remontu.");
  } else {
    risks.push("Brak jednoznacznej informacji o stanie do remontu.");
  }

  if (input.price !== null && input.price < FLIP_SCORE_RULES.priceThreshold) {
    score += FLIP_SCORE_RULES.priceBelowThreshold;
    reasons.push("Cena ofertowa poniżej 350 000 zł.");
  } else if (input.price !== null) {
    risks.push("Cena ofertowa wynosi co najmniej 350 000 zł.");
  }

  return { score, label: scoreLabel(score), reasons, risks };
}

function scoreLabel(score: number): FlipScoreLabel {
  if (score >= 60) return "Okazja";
  if (score >= 40) return "Bardzo dobry";
  if (score >= 20) return "Dobry";
  return "Słaby";
}
