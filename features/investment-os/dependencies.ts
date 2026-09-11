import type { AnalysisLevel } from "./types";

export type FoundationDirector = "VERIFY" | "MARKET" | "RISK" | "RENOVATION" | "UNDERWRITER" | "CFO" | "ACQUISITION";
export const FOUNDATION_DIRECTORS: FoundationDirector[] = ["VERIFY", "MARKET", "RISK", "RENOVATION", "UNDERWRITER", "CFO", "ACQUISITION"];
export type DependencyDefinition = { director: FoundationDirector; dependsOnFields: string[]; dependsOnDirectors: FoundationDirector[]; minimumLevel: AnalysisLevel };

export const DIRECTOR_DEPENDENCY_REGISTRY: Record<FoundationDirector, DependencyDefinition> = {
  VERIFY: { director: "VERIFY", dependsOnFields: ["identity", "source", "sourceUrl", "postId", "areaM2", "rooms", "city", "district", "street", "buildingType", "ownership", "condition"], dependsOnDirectors: [], minimumLevel: 0 },
  MARKET: { director: "MARKET", dependsOnFields: ["areaM2", "rooms", "city", "district", "street", "buildingType"], dependsOnDirectors: ["VERIFY"], minimumLevel: 1 },
  RISK: { director: "RISK", dependsOnFields: ["identity", "ownership", "buildingType", "condition", "legalStatus"], dependsOnDirectors: ["VERIFY"], minimumLevel: 1 },
  RENOVATION: { director: "RENOVATION", dependsOnFields: ["areaM2", "condition", "buildingType"], dependsOnDirectors: ["VERIFY"], minimumLevel: 1 },
  UNDERWRITER: { director: "UNDERWRITER", dependsOnFields: ["askingPrice", "areaM2", "rooms", "city", "condition", "marketEvidence", "renovationEstimate"], dependsOnDirectors: ["VERIFY", "MARKET", "RENOVATION"], minimumLevel: 1 },
  CFO: { director: "CFO", dependsOnFields: ["askingPrice", "equity", "financing", "renovationEstimate", "holdingCost"], dependsOnDirectors: ["UNDERWRITER"], minimumLevel: 2 },
  ACQUISITION: { director: "ACQUISITION", dependsOnFields: ["askingPrice", "maxPurchasePrice", "identity", "riskReview"], dependsOnDirectors: ["VERIFY", "RISK", "UNDERWRITER"], minimumLevel: 2 },
};

export function validateDependencyGraph(registry = DIRECTOR_DEPENDENCY_REGISTRY): void {
  const visiting = new Set<FoundationDirector>(); const visited = new Set<FoundationDirector>();
  const visit = (director: FoundationDirector) => { if (visiting.has(director)) throw new Error(`DIRECTOR_DEPENDENCY_CYCLE:${director}`); if (visited.has(director)) return; visiting.add(director); for (const dependency of registry[director].dependsOnDirectors) visit(dependency); visiting.delete(director); visited.add(director); };
  for (const director of Object.keys(registry) as FoundationDirector[]) visit(director);
}

export type InvalidationTarget = FoundationDirector | "CEO";
export function affectedDirectors(changedFields: string[], registry = DIRECTOR_DEPENDENCY_REGISTRY): InvalidationTarget[] {
  validateDependencyGraph(registry); const direct = new Set(Object.values(registry).filter((item) => item.dependsOnFields.some((field) => changedFields.includes(field))).map((item) => item.director));
  let changed = true; while (changed) { changed = false; for (const item of Object.values(registry)) if (item.dependsOnDirectors.some((dependency) => direct.has(dependency)) && !direct.has(item.director)) { direct.add(item.director); changed = true; } }
  return [...FOUNDATION_DIRECTORS.filter((director) => direct.has(director)), ...(direct.size ? ["CEO" as const] : [])];
}

/** Build the only input a director is allowed to receive from the Deal aggregate. */
export function declaredInputSnapshot(director: FoundationDirector, values: Record<string, unknown>, registry = DIRECTOR_DEPENDENCY_REGISTRY): Record<string, unknown> {
  const definition = registry[director];
  if (!definition) throw new Error(`DIRECTOR_NOT_REGISTERED:${director}`);
  return Object.fromEntries(definition.dependsOnFields.map((field) => [field, values[field] ?? null]));
}
