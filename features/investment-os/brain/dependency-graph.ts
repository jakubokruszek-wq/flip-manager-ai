import { BRAIN_DIRECTORS, type BrainDependencyDefinition, type BrainDependencyEdge, type BrainDirectorId } from "./types.ts";

export const DEAL_BRAIN_DEPENDENCIES: readonly BrainDependencyDefinition[] = [
  { director: "SCOUT", dependsOnDirectors: [], dependsOnFields: ["source", "sourceUrl", "postId", "askingPrice", "areaM2", "rooms", "floor", "city", "district", "street", "buildingType", "imageCount", "observedAt"], rationale: "Opisuje wyłącznie fakty zapisane przy ofercie." },
  { director: "VERIFY", dependsOnDirectors: ["SCOUT"], dependsOnFields: ["identity", "source", "sourceUrl", "postId", "askingPrice", "areaM2", "rooms", "city", "district", "street", "buildingType", "ownership", "condition"], rationale: "Sprawdza kompletność, konflikty i pochodzenie danych oferty." },
  { director: "MARKET", dependsOnDirectors: ["VERIFY"], dependsOnFields: ["areaM2", "rooms", "city", "district", "street", "buildingType", "marketEvidence"], rationale: "Korzysta z istniejącego wyniku rynku i jego źródeł." },
  { director: "RENOVATION", dependsOnDirectors: ["VERIFY"], dependsOnFields: ["areaM2", "condition", "buildingType", "renovationAssumption"], rationale: "Pokazuje koszt i zakres z kanonicznego underwritingu." },
  { director: "UNDERWRITER", dependsOnDirectors: ["VERIFY", "MARKET", "RENOVATION"], dependsOnFields: ["askingPrice", "areaM2", "rooms", "condition", "marketEvidence", "renovationAssumption", "transactionCosts"], rationale: "Prezentuje wynik istniejącego silnika bez ponownego liczenia finansów." },
  { director: "RISK_LEGAL", dependsOnDirectors: ["VERIFY"], dependsOnFields: ["identity", "ownership", "legalStatus", "buildingType", "condition", "factConflicts"], rationale: "Porządkuje wyłącznie ryzyka wynikające z zapisanych faktów i bramek." },
  { director: "CFO", dependsOnDirectors: ["UNDERWRITER"], dependsOnFields: ["askingPrice", "totalProjectCost", "profit", "roi", "financing"], rationale: "Interpretuje kanoniczne liczby; nie dopisuje nieobecnych założeń finansowania." },
  { director: "ACQUISITION", dependsOnDirectors: ["UNDERWRITER", "RISK_LEGAL"], dependsOnFields: ["askingPrice", "maxPurchasePrice", "buyGate", "manualDecision"], rationale: "Przekłada istniejące bramki i limit ceny na warunkowe działanie." },
  { director: "SALE", dependsOnDirectors: ["MARKET"], dependsOnFields: ["resaleValue", "comparables", "marketFreshness"], rationale: "Ocenia wyjście na podstawie istniejących danych rynkowych." },
  { director: "CEO", dependsOnDirectors: ["SCOUT", "VERIFY", "MARKET", "RENOVATION", "UNDERWRITER", "RISK_LEGAL", "CFO", "ACQUISITION", "SALE"], dependsOnFields: ["allMaterialDirectorOutputs", "buyGate", "canonicalDecision"], rationale: "Syntetyzuje wyniki dyrektorów i kanoniczną decyzję; nie liczy ekonomiki." },
] as const;

const definitions = new Map(DEAL_BRAIN_DEPENDENCIES.map((item) => [item.director, item]));

export function validateDealBrainGraph(nodes: readonly BrainDependencyDefinition[] = DEAL_BRAIN_DEPENDENCIES): void {
  const byId = new Map(nodes.map((item) => [item.director, item]));
  const visiting = new Set<BrainDirectorId>();
  const visited = new Set<BrainDirectorId>();
  const visit = (id: BrainDirectorId) => {
    if (visiting.has(id)) throw new Error(`DEAL_BRAIN_DEPENDENCY_CYCLE:${id}`);
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error(`DEAL_BRAIN_DEPENDENCY_NODE_MISSING:${id}`);
    visiting.add(id);
    for (const dependency of node.dependsOnDirectors) {
      if (!byId.has(dependency)) throw new Error(`DEAL_BRAIN_DEPENDENCY_NODE_MISSING:${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of BRAIN_DIRECTORS) visit(id);
}

export function topologicalDirectorOrder(): BrainDirectorId[] {
  validateDealBrainGraph();
  const ordered: BrainDirectorId[] = [];
  const visited = new Set<BrainDirectorId>();
  const visit = (id: BrainDirectorId) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dependency of definitions.get(id)!.dependsOnDirectors) visit(dependency);
    ordered.push(id);
  };
  for (const id of BRAIN_DIRECTORS) visit(id);
  return ordered;
}

export function dealBrainEdges(nodes: readonly BrainDependencyDefinition[] = DEAL_BRAIN_DEPENDENCIES): BrainDependencyEdge[] {
  return nodes.flatMap((node) => node.dependsOnDirectors.map((from) => ({ from, to: node.director, fields: node.dependsOnFields })));
}

export function dependenciesFor(id: BrainDirectorId): BrainDirectorId[] {
  return [...(definitions.get(id)?.dependsOnDirectors ?? [])];
}
