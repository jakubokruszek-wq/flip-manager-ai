import type { RenovationLevel, RenovationOption } from "@/features/renovation-visualizer/types";
import { RENOVATION_CATEGORIES } from "./renovation-categories.ts";
import type { RenovationCategoryKey, RenovationCostTier, RenovationEstimate, RenovationEstimateCategory, RenovationEstimateInput } from "./types.ts";

export const RENOVATION_RATES: Record<RenovationCostTier, { min: number; max: number; label: string }> = {
  economy: { min: 1_700, max: 2_000, label: "Economy" },
  standard: { min: 1_900, max: 2_200, label: "Standard" },
  premium: { min: 2_300, max: 2_700, label: "Premium" },
};

const BASE_WEIGHTS: Record<RenovationCategoryKey, number> = {
  demolition: 5,
  walls: 6,
  painting: 6,
  floors: 10,
  electrical: 10,
  plumbing: 8,
  kitchen: 20,
  bathroom: 18,
  doors: 5,
  lighting: 4,
  furniture: 10,
  carpentry: 12,
  reserve: 8,
};

const OPTION_CATEGORY: Partial<Record<RenovationOption, RenovationCategoryKey>> = {
  floors: "floors", doors: "doors", kitchen: "kitchen", bathroom: "bathroom", lighting: "lighting", furniture: "furniture", carpentry: "carpentry",
};

export function estimateRenovation(input: RenovationEstimateInput): RenovationEstimate {
  const hasKnownArea = typeof input.area === "number" && Number.isFinite(input.area) && input.area > 0;
  const area = hasKnownArea ? input.area as number : 50;
  const rates = RENOVATION_RATES[input.tier];
  const totalMin = roundCurrency(area * rates.min);
  const totalMax = roundCurrency(area * rates.max);
  const estimatedBudget = roundCurrency((totalMin + totalMax) / 2);
  const selectedKeys = selectedCategories(input.renovationLevel, input.options);
  const categories = distribute(totalMin, totalMax, selectedKeys);
  const warnings: string[] = [];

  if (!hasKnownArea) warnings.push("Brak metrażu nieruchomości — kosztorys przyjmuje orientacyjne 50 m².");
  if (input.budget < estimatedBudget) warnings.push(`Wybrany zakres przekracza budżet o około ${money(estimatedBudget - input.budget)}.`);
  warnings.push("Kosztorys jest deterministyczny i oparty na stawkach za m²; wymaga potwierdzenia ofertami wykonawców.");

  const complexity = selectedKeys.length + (input.renovationLevel === "general" ? 4 : input.renovationLevel === "standard" ? 2 : 0);
  const timelineDaysMin = Math.max(4, Math.round(area / 8 + complexity * 1.5));
  const timelineDaysMax = Math.max(timelineDaysMin + 3, Math.round(area / 4 + complexity * 3));

  return {
    tier: input.tier,
    area,
    rateMin: rates.min,
    rateMax: rates.max,
    totalMin,
    totalMax,
    estimatedBudget,
    userBudget: input.budget,
    budgetDifference: input.budget - estimatedBudget,
    confidence: hasKnownArea ? 95 : 60,
    categories,
    timelineDaysMin,
    timelineDaysMax,
    warnings,
  };
}

function selectedCategories(level: RenovationLevel, options: RenovationOption[]): RenovationCategoryKey[] {
  const selected = new Set<RenovationCategoryKey>(["painting", "reserve"]);
  if (level !== "refresh") ["demolition", "walls", "electrical"].forEach((key) => selected.add(key as RenovationCategoryKey));
  if (level === "general") ["floors", "plumbing", "doors"].forEach((key) => selected.add(key as RenovationCategoryKey));
  options.forEach((option) => { const category = OPTION_CATEGORY[option]; if (category) selected.add(category); });
  return [...selected];
}

function distribute(totalMin: number, totalMax: number, keys: RenovationCategoryKey[]): RenovationEstimateCategory[] {
  const weightTotal = keys.reduce((sum, key) => sum + BASE_WEIGHTS[key], 0);
  let assignedMin = 0;
  let assignedMax = 0;
  return keys.map((key, index) => {
    const definition = RENOVATION_CATEGORIES[key];
    const last = index === keys.length - 1;
    const min = last ? totalMin - assignedMin : Math.round(totalMin * BASE_WEIGHTS[key] / weightTotal);
    const max = last ? totalMax - assignedMax : Math.round(totalMax * BASE_WEIGHTS[key] / weightTotal);
    assignedMin += min;
    assignedMax += max;
    return { name: definition.name, description: definition.description, min, max, items: definition.items.map((name) => ({ name, min: 0, max: 0 })) };
  });
}

function roundCurrency(value: number): number { return Math.round(value); }
function money(value: number): string { return `${Math.round(value).toLocaleString("pl-PL")} zł`; }
