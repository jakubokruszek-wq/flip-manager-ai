import { calculatePurchasePriceLimits } from "./calculate-max-purchase-price";
import type { PurchaseDecision, PurchaseRecommendation, PurchaseRecommendationInput } from "./types";

const SAFETY_BUFFER = 0.05;
const NEGOTIATION_BUFFER = 0.05;
const NEGOTIATION_THRESHOLD = 0.08;

export function getPurchaseRecommendation(input: PurchaseRecommendationInput): PurchaseRecommendation {
  const limits = calculatePurchasePriceLimits(input);
  const strictLimit = lowestLimit(limits.maxPriceForTargetProfit, limits.maxPriceForTargetRoi);
  const recommendedMaxPrice = strictLimit === null ? null : strictLimit * (1 - SAFETY_BUFFER);
  const negotiationTarget =
    recommendedMaxPrice === null ? null : recommendedMaxPrice * (1 - NEGOTIATION_BUFFER);
  const currentPriceDifference =
    isValidPrice(input.currentListingPrice) && recommendedMaxPrice !== null
      ? input.currentListingPrice - recommendedMaxPrice
      : null;
  const currentPriceDifferencePercent =
    currentPriceDifference !== null && recommendedMaxPrice !== null && recommendedMaxPrice > 0
      ? (currentPriceDifference / recommendedMaxPrice) * 100
      : null;
  const decision = decide(input.currentListingPrice, recommendedMaxPrice);

  return {
    maxPriceForTargetProfit: limits.maxPriceForTargetProfit,
    maxPriceForTargetRoi: limits.maxPriceForTargetRoi,
    recommendedMaxPrice,
    negotiationTarget,
    currentPriceDifference,
    currentPriceDifferencePercent,
    targetProfit: input.targetProfit,
    targetRoi: input.targetRoi,
    decision,
    reasons: reasonsFor(decision, input, limits.maxPriceForTargetProfit, limits.maxPriceForTargetRoi),
    risks: risksFor(input, recommendedMaxPrice, currentPriceDifferencePercent),
    potentialProfit: limits.potentialProfit,
    potentialRoi: limits.potentialRoi,
  };
}

function decide(currentPrice: number | null, recommendedMaxPrice: number | null): PurchaseDecision {
  if (!isValidPrice(currentPrice) || recommendedMaxPrice === null) return "reject";
  if (currentPrice <= recommendedMaxPrice) return "buy";
  return currentPrice <= recommendedMaxPrice * (1 + NEGOTIATION_THRESHOLD) ? "negotiate" : "reject";
}

function reasonsFor(
  decision: PurchaseDecision,
  input: PurchaseRecommendationInput,
  maxPriceForTargetProfit: number | null,
  maxPriceForTargetRoi: number | null,
): string[] {
  const reasons = [
    `Cel zysku: ${formatCurrency(input.targetProfit)}.`,
    `Cel ROI: ${formatPercent(input.targetRoi)}.`,
  ];
  if (maxPriceForTargetProfit !== null) reasons.push(`Limit dla celu zysku: ${formatCurrency(maxPriceForTargetProfit)}.`);
  if (maxPriceForTargetRoi !== null) reasons.push(`Limit dla celu ROI: ${formatCurrency(maxPriceForTargetRoi)}.`);
  if (decision === "buy") reasons.push("Cena ofertowa mieści się w bezpiecznej rekomendowanej cenie zakupu.");
  if (decision === "negotiate") reasons.push("Cena przekracza rekomendację nie więcej niż o 8%; negocjacja może przywrócić założenia inwestycji.");
  if (decision === "reject") reasons.push("Cena nie spełnia bezpiecznych założeń zakupu dla zadanych celów inwestycyjnych.");
  return reasons;
}

function risksFor(
  input: PurchaseRecommendationInput,
  recommendedMaxPrice: number | null,
  currentPriceDifferencePercent: number | null,
): string[] {
  const risks: string[] = [];
  if (!isValidPrice(input.estimatedAfterRenovationPrice)) risks.push("Brak wyceny po remoncie uniemożliwia wiarygodną rekomendację.");
  if (!isValidPrice(input.currentListingPrice)) risks.push("Brak aktualnej ceny ofertowej.");
  if (recommendedMaxPrice === null) risks.push("Brak pełnych danych do wyznaczenia maksymalnej ceny zakupu.");
  if ((input.renovationCost ?? 0) === 0) risks.push("Koszt remontu wynosi 0 zł — zweryfikuj założenie w Kalkulatorze.");
  if (currentPriceDifferencePercent !== null && currentPriceDifferencePercent > NEGOTIATION_THRESHOLD * 100) risks.push("Cena ofertowa przekracza bezpieczny limit o więcej niż 8%.");
  return risks;
}

function lowestLimit(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}

function isValidPrice(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatCurrency(value: number | null): string {
  return isValidPrice(value)
    ? new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value)
    : "brak danych";
}

function formatPercent(value: number | null): string {
  return isValidPrice(value) ? `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value)}%` : "brak danych";
}
