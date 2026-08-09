export const FLIP_SCORE_RULES = {
  pricePerSqm: { below: 20, equal: 10, above: -20 },
  rooms: 10,
  area: 10,
  secondaryMarket: 10,
  renovation: 20,
  priceBelowThreshold: 10,
  priceThreshold: 350_000,
} as const;

const RENOVATION_PATTERN = /\b(do\s+(generalnego\s+)?remontu|wymaga\s+remontu|do\s+odświeżenia)\b/i;

export function isRenovationListing(title: string | null, description: string | null): boolean {
  return RENOVATION_PATTERN.test(`${title ?? ""} ${description ?? ""}`);
}
