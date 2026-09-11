export type FunnelDecisionRow = {
  postId: string;
  decision: "MATCHED" | "REVIEW" | "REJECTED" | null;
  decisionReasons?: string[];
};

/** Counts hard negatives once per post while retaining overlapping reason counts. */
export function summarizeHardRejects(rows: FunnelDecisionRow[]): { unique: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  let unique = 0;
  for (const row of rows) {
    if (row.decision !== "REJECTED") continue;
    unique += 1;
    const mapped = (row.decisionReasons ?? []).map(mapHardReason).filter((value): value is string => value !== null);
    for (const reason of new Set(mapped.length ? mapped : ["other"])) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { unique, reasons };
}

function mapHardReason(reason: string): string | null {
  const value = reason.toLowerCase();
  if (["city", "outside_lodz", "outside_location"].includes(value)) return "outsideLocation";
  if (value === "district") return "districtMismatch";
  if (["area_min", "area_below_min"].includes(value)) return "areaBelowMin";
  if (["area_max", "area_above_max"].includes(value)) return "areaAboveMax";
  if (["max_price_per_sqm", "price_per_sqm_max"].includes(value)) return "pricePerSqmAboveMax";
  if (["rooms", "rooms_min", "rooms_max", "rooms_mismatch"].includes(value)) return "roomsMismatch";
  if (["building_type", "tenement", "kamienica", "excluded_building_type"].includes(value)) return "excludedBuildingType";
  if (value.includes("duplicate")) return "duplicate";
  if (value.includes("age") || value.includes("old")) return "ageCutoff";
  if (value.includes("rent")) return "rent";
  if (["price_missing", "area_missing", "rooms_missing", "building_type_missing", "city_missing", "district_missing"].includes(value)) return null;
  return "other";
}
