export const ANALYSIS_RULES = {
  renovationPerSqm: {
    full: { min: 2_000, max: 3_000 },
    partial: { min: 1_000, max: 1_700 },
    standard: { min: 500, max: 1_000 },
  },
  negotiationDiscount: 0.03,
  highFlipScore: 40,
  lowFlipScore: 20,
} as const;

const FULL_RENOVATION_PATTERN = /\b(do\s+(generalnego\s+)?remontu|generalny\s+remont|wymaga\s+remontu)\b/i;
const PARTIAL_RENOVATION_PATTERN = /\b(do\s+odświeżenia|do\s+aranżacji|odświeżenia)\b/i;
const NEGOTIATION_PATTERN = /\b(cena\s+do\s+negocjacji|do\s+negocjacji|pilna\s+sprzedaż|okazja)\b/i;
const ELEVATOR_PATTERN = /\b(winda|windą)\b/i;

export function renovationScope(title: string | null, description: string | null): "full" | "partial" | "standard" {
  const content = `${title ?? ""} ${description ?? ""}`;
  if (FULL_RENOVATION_PATTERN.test(content)) return "full";
  if (PARTIAL_RENOVATION_PATTERN.test(content)) return "partial";
  return "standard";
}

export function canNegotiate(title: string | null, description: string | null): boolean {
  return NEGOTIATION_PATTERN.test(`${title ?? ""} ${description ?? ""}`);
}

export function hasElevator(title: string | null, description: string | null): boolean {
  return ELEVATOR_PATTERN.test(`${title ?? ""} ${description ?? ""}`);
}

export function floorNumber(floor: string | null): number | null {
  if (!floor) return null;
  const numeric = Number(floor.match(/\d+/)?.[0]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const roman = floor.trim().toUpperCase();
  return roman === "I" ? 1 : roman === "II" ? 2 : roman === "III" ? 3 : roman === "IV" ? 4 : roman === "V" ? 5 : null;
}
