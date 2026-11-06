import type { PropertyStatus } from "@/features/properties/types";

export const INVESTMENT_STATUSES: readonly PropertyStatus[] = [
  "acquired", "renovation", "listed", "sold",
];

export const INVESTMENT_STATUS_LABELS: Record<"acquired" | "renovation" | "listed" | "sold", string> = {
  acquired: "Kupiona",
  renovation: "Remont",
  listed: "W sprzedaży",
  sold: "Sprzedana",
};

export function isInvestmentStatus(status: PropertyStatus): status is keyof typeof INVESTMENT_STATUS_LABELS {
  return INVESTMENT_STATUSES.includes(status);
}
