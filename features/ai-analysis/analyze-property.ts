import { ANALYSIS_RULES, canNegotiate, floorNumber, hasElevator, renovationScope } from "./rules";
import type { PropertyAnalysis, PropertyAnalysisInput } from "./types";

export function analyzeProperty(input: PropertyAnalysisInput): PropertyAnalysis {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const risks: string[] = [];
  const recommendations: string[] = [];
  const scope = renovationScope(input.title, input.description);
  const renovation = estimateRenovation(input.area, scope);

  if (input.price !== null && input.price < 350_000) strengths.push("Atrakcyjna cena ofertowa poniżej 350 000 zł.");
  if (input.pricePerSqm !== null && input.averagePricePerSqm !== null) {
    if (input.pricePerSqm < input.averagePricePerSqm) strengths.push("Cena za m² jest poniżej poziomu referencyjnego.");
    else if (input.pricePerSqm > input.averagePricePerSqm) weaknesses.push("Cena za m² jest powyżej poziomu referencyjnego.");
  } else {
    risks.push("Brak referencyjnej ceny za m² do porównania.");
  }
  if (input.area !== null && input.area >= 35 && input.area <= 65) strengths.push("Dobry metraż dla mieszkania inwestycyjnego.");
  if (input.rooms !== null && input.rooms >= 2 && input.rooms <= 3) strengths.push("Funkcjonalny układ 2–3 pokoi.");
  if (input.marketType === "secondary") strengths.push("Rynek wtórny sprzyja negocjacjom i modernizacji.");
  if (input.flipScore >= ANALYSIS_RULES.highFlipScore) strengths.push("Wysoki Flip Score potwierdza potencjał inwestycyjny.");
  if (input.flipScore < ANALYSIS_RULES.lowFlipScore) weaknesses.push("Niski Flip Score wymaga ostrożniejszej weryfikacji.");

  if (scope === "full") risks.push("Pełny remont może wydłużyć harmonogram i zwiększyć ryzyko budżetowe.");
  else if (scope === "partial") weaknesses.push("Nieruchomość wymaga odświeżenia przed sprzedażą.");
  const floor = floorNumber(input.floor);
  if (floor !== null && floor >= 4 && !hasElevator(input.title, input.description)) risks.push(`${input.floor} piętro bez potwierdzonej windy może ograniczyć grupę kupujących.`);
  if (input.marketType === "primary") weaknesses.push("Rynek pierwotny zwykle daje mniejszą przestrzeń do negocjacji.");

  if (canNegotiate(input.title, input.description) || input.pricePerSqm !== null && input.averagePricePerSqm !== null && input.pricePerSqm > input.averagePricePerSqm) recommendations.push("Warto negocjować cenę zakupu przed podjęciem decyzji.");
  if (scope === "full") recommendations.push(`Załóż remont w budżecie ${formatAmount(renovation.min)}–${formatAmount(renovation.max)}.`);
  else recommendations.push(`Zweryfikuj zakres prac; obecny szacunek to ${formatAmount(renovation.min)}–${formatAmount(renovation.max)}.`);
  if (input.price === null || input.area === null) recommendations.push("Uzupełnij brakujące dane przed finalną decyzją inwestycyjną.");

  const estimatedProfit = estimateProfit(input, renovation);
  const confidence = confidenceFor(input);
  const summary = createSummary(input, estimatedProfit, scope);

  return { summary, strengths, weaknesses, risks, recommendations, estimatedRenovation: renovation, estimatedProfit, confidence };
}

function estimateRenovation(area: number | null, scope: "full" | "partial" | "standard") {
  const rate = ANALYSIS_RULES.renovationPerSqm[scope];
  const calculatedArea = area ?? 50;
  return { min: calculatedArea * rate.min, max: calculatedArea * rate.max };
}

function estimateProfit(input: PropertyAnalysisInput, renovation: { min: number; max: number }): number | null {
  if (input.price === null || input.area === null || input.averagePricePerSqm === null) return null;
  const estimatedSalePrice = input.area * input.averagePricePerSqm * (1 + ANALYSIS_RULES.negotiationDiscount);
  return Math.round(estimatedSalePrice - input.price - (renovation.min + renovation.max) / 2);
}

function confidenceFor(input: PropertyAnalysisInput): number {
  const values = [input.price, input.pricePerSqm, input.averagePricePerSqm, input.area, input.rooms, input.floor, input.marketType];
  return Math.round((values.filter((value) => value !== null).length / values.length) * 100);
}

function createSummary(input: PropertyAnalysisInput, estimatedProfit: number | null, scope: string): string {
  const scoreText = `Flip Score: ${input.flipScore}.`;
  const renovationText = scope === "full" ? "Oferta wymaga pełnego remontu." : "Zakres remontu wymaga weryfikacji.";
  const profitText = estimatedProfit === null ? "Brakuje danych do szacunku zysku." : `Szacowany zysk: ${formatAmount(estimatedProfit)}.`;
  return `${scoreText} ${renovationText} ${profitText}`;
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}
