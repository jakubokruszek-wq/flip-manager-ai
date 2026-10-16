import type { DealListingInput, MarketEvidence } from "./types";
import type { ResaleCompRecord } from "../market-intelligence/resale-comps";
import { normalizeConfirmedPropertyIdentity } from "../flip-finder/property-identity";

type Row = Record<string, unknown>;
const normalized = (v: string | null) => (v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g,"l").toLowerCase().trim();
const building = (v: string | null) => /^(block|blok)$/.test(normalized(v)) ? "blok" : normalized(v);
export function freshMarketDate(value: unknown, now: string, maxAge = 30): boolean {
  const age = typeof value === "string" ? (Date.parse(now)-Date.parse(value))/86400000 : NaN;
  return Number.isFinite(age) && age >= 0 && age <= maxAge;
}
/** Restrict the legacy global sidecar before its existing selector runs. No private operator rows or fuzzy identity merges. */
export function eligibleGeneralComp(row: Row, comp: ResaleCompRecord, subject: DealListingInput, actorId: string | undefined, now: string): boolean {
  if (row.owner_id != null && row.owner_id !== actorId) return false;
  if (!freshMarketDate(comp.lastSeenAt,now) || row.excluded_at || row.exclusion_reason || row.outlier_reason || row.manual_decision === "REJECTED") return false;
  if (comp.id === subject.id || comp.canonicalUrl === subject.sourceUrl || (comp.source === subject.source && comp.externalListingId === subject.externalListingId)) return false;
  if (!subject.city || !subject.district || normalized(comp.city) !== normalized(subject.city) || normalized(comp.district) !== normalized(subject.district)) return false;
  if (!comp.price || !comp.areaM2 || !comp.pricePerM2 || Math.abs(comp.price / comp.areaM2 - comp.pricePerM2) / comp.pricePerM2 > .01) return false;
  if (!subject.buildingType || building(comp.buildingType) !== building(subject.buildingType) || !subject.rooms || comp.rooms !== subject.rooms) return false;
  if (comp.classification.renovationStatus !== "RENOVATED" || comp.classification.renovationConfidence !== "HIGH") return false;
  const evidence = row.evidence !== null && typeof row.evidence === "object" && !Array.isArray(row.evidence) ? row.evidence as Row : {};
  const market = row.market_type ?? evidence.marketType;
  if (market !== "secondary" && !(market == null && /rynek\s+wt[oó]rny/i.test(comp.description ?? "") && !/rynek\s+pierwotny/i.test(comp.description ?? ""))) return false;
  try { const url = new URL(comp.canonicalUrl ?? ""); if(url.protocol !== "https:" || url.username || url.password) return false; } catch { return false; }
  return true;
}
export function generalCompKey(row: Row, comp: ResaleCompRecord): string {
  return normalizeConfirmedPropertyIdentity(row.cross_source_identity) ?? `${comp.source}:${comp.externalListingId}`;
}
export function markIndicative(evidence: MarketEvidence, sourceLabel: string, radar: MarketEvidence | null): MarketEvidence {
  return { ...evidence, indicative: true, sourceLabel, confidence: Math.min(60,evidence.confidence), fallbackReason: `WYCENA ORIENTACYJNA: ${sourceLabel}. Radar: ${radar?.compCount ?? 0} niezależnych porównań; niewystarczająca próba lub brak dostępu.`, radarAudit: radar?.radarAudit, assumptionQuestion: `Czy przyjmujemy orientacyjnie ${Math.round(evidence.base)} zł/m² na podstawie: ${sourceLabel}?` };
}
export function usableRadar(evidence: MarketEvidence, now: string): boolean {
  return evidence.compCount >= (evidence.minimumSample ?? 10) && evidence.low > 0 && evidence.low <= evidence.base && evidence.base <= evidence.high && freshMarketDate(evidence.observedAt,now);
}
