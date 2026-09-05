import type { ComparableListing } from "./types";
import type { ResaleCompRecord } from "./resale-comps";
import { ANALYSIS_RULES } from "../ai-analysis/rules.ts";

export type ArvSubject = {
  id: string;
  area: number | null;
  rooms: number | null;
  city: string | null;
  district: string | null;
  address: string | null;
  buildingType?: string | null;
  floor?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type ResaleArv = {
  compCount: number;
  medianPricePerSqm: number | null;
  weightedPricePerSqm: number | null;
  conservativePrice: number | null;
  expectedPrice: number | null;
  optimisticPrice: number | null;
  recommendedListingPrice: number | null;
  estimatedSalePrice: number | null;
  comparables: ComparableListing[];
};

const MAX_COMPS = 10;

export function selectResaleComps(subject: ArvSubject, candidates: ResaleCompRecord[], now = Date.now()): ComparableListing[] {
  return candidates
    .filter((candidate) => eligible(subject, candidate))
    .map((candidate) => {
      const distanceMeters = distance(subject, candidate);
      const freshnessDays = ageDays(candidate.lastSeenAt, now);
      const { score, reasons } = scoreCandidate(subject, candidate, distanceMeters, freshnessDays);
      return {
        id: candidate.id ?? `${candidate.source}:${candidate.externalListingId}`,
        title: candidate.title,
        originalUrl: candidate.canonicalUrl,
        normalizedUrl: candidate.canonicalUrl,
        price: candidate.price,
        area: candidate.areaM2,
        pricePerSqm: candidate.pricePerM2,
        rooms: candidate.rooms,
        buildingType: candidate.buildingType,
        address: candidate.address,
        district: candidate.district,
        city: candidate.city,
        source: candidate.source,
        lastSeenAt: candidate.lastSeenAt,
        similarityScore: score,
        matchReasons: reasons,
        renovationConfidence: candidate.classification.renovationConfidence,
        renovationStatus: candidate.classification.renovationStatus,
        freshnessDays,
        distanceMeters,
        outlierReason: candidate.classification.outlierReason,
      } satisfies ComparableListing;
    })
    .sort((left, right) => right.similarityScore - left.similarityScore || (left.freshnessDays ?? Infinity) - (right.freshnessDays ?? Infinity))
    .slice(0, MAX_COMPS);
}

export function calculateResaleArv(subject: Pick<ArvSubject, "area">, comparables: ComparableListing[], negotiationFactor = ANALYSIS_RULES.negotiationDiscount): ResaleArv {
  const values = comparables.flatMap((candidate) => candidate.pricePerSqm !== null && candidate.pricePerSqm > 0 ? [{ value: candidate.pricePerSqm, weight: comparableWeight(candidate) }] : []);
  if (!values.length) return { compCount: 0, medianPricePerSqm: null, weightedPricePerSqm: null, conservativePrice: null, expectedPrice: null, optimisticPrice: null, recommendedListingPrice: null, estimatedSalePrice: null, comparables: [] };
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const medianPricePerSqm = weightedQuantile(sorted, 0.5);
  const lowPerSqm = weightedQuantile(sorted, 0.2);
  const highPerSqm = weightedQuantile(sorted, 0.8);
  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
  const weightedPricePerSqm = totalWeight > 0 ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight : medianPricePerSqm;
  const area = subject.area !== null && Number.isFinite(subject.area) && subject.area > 0 ? subject.area : null;
  const expected = weightedPricePerSqm ?? medianPricePerSqm;
  const expectedPrice = area !== null && expected !== null ? expected * area : null;
  const conservativePrice = area !== null && lowPerSqm !== null ? lowPerSqm * area : null;
  const optimisticPrice = area !== null && highPerSqm !== null ? highPerSqm * area : null;
  const safeNegotiation = Number.isFinite(negotiationFactor) ? Math.min(0.3, Math.max(0, negotiationFactor)) : ANALYSIS_RULES.negotiationDiscount;
  return {
    compCount: comparables.length,
    medianPricePerSqm,
    weightedPricePerSqm,
    conservativePrice,
    expectedPrice,
    optimisticPrice,
    recommendedListingPrice: expectedPrice,
    estimatedSalePrice: expectedPrice === null ? null : expectedPrice * (1 - safeNegotiation),
    comparables,
  };
}

function eligible(subject: ArvSubject, candidate: ResaleCompRecord): boolean {
  if (!candidate.active || candidate.classification.renovationConfidence === "LOW" || candidate.classification.outlierReason || candidate.classification.exclusionReason) return false;
  if (candidate.classification.renovationConfidence !== "HIGH" && candidate.classification.renovationConfidence !== "MEDIUM") return false;
  if (!candidate.pricePerM2 || candidate.pricePerM2 <= 0 || !candidate.areaM2 || candidate.areaM2 <= 0) return false;
  if (!sameCity(subject.city, candidate.city)) return false;
  if (subject.area && Math.abs(subject.area - candidate.areaM2) / subject.area > 0.15) return false;
  if (subject.rooms !== null && candidate.rooms !== null && Math.abs(subject.rooms - candidate.rooms) > 1) return false;
  if (isNonTenement(subject.buildingType) && isTenement(candidate.buildingType)) return false;
  return true;
}

function scoreCandidate(subject: ArvSubject, candidate: ResaleCompRecord, distanceMeters: number | null, freshnessDays: number | null): { score: number; reasons: string[] } {
  let score = 10;
  const reasons = ["to samo miasto"];
  if (sameStreet(subject.address, candidate.address)) { score += 45; reasons.unshift("ta sama ulica"); }
  else if (distanceMeters !== null && distanceMeters <= 500) { score += 35; reasons.unshift("do 500 m"); }
  else if (distanceMeters !== null && distanceMeters <= 1_000) { score += 25; reasons.unshift("do 1 km"); }
  else if (sameValue(subject.district, candidate.district)) { score += 18; reasons.unshift("ta sama dzielnica"); }
  if (subject.area !== null && candidate.areaM2 !== null) { score += Math.max(0, Math.round(15 - Math.abs(subject.area - candidate.areaM2) / Math.max(subject.area, 1) * 100)); reasons.push("podobny metraż"); }
  if (subject.rooms !== null && candidate.rooms !== null && subject.rooms === candidate.rooms) { score += 10; reasons.push("ta sama liczba pokoi"); }
  if (subject.buildingType && candidate.buildingType && sameValue(subject.buildingType, candidate.buildingType)) { score += 8; reasons.push("podobny typ budynku"); }
  if (subject.floor && candidate.floor && sameValue(subject.floor, candidate.floor)) { score += 4; reasons.push("podobne piętro"); }
  if (freshnessDays !== null && freshnessDays <= 30) { score += 5; reasons.push("świeża oferta"); }
  if (candidate.classification.renovationConfidence === "HIGH") { score += 5; reasons.push("pewność remontu HIGH"); }
  return { score: Math.min(100, score), reasons };
}

function comparableWeight(candidate: ComparableListing): number {
  const freshness = candidate.freshnessDays === null || candidate.freshnessDays === undefined ? 0.1 : candidate.freshnessDays <= 30 ? 1 : candidate.freshnessDays <= 60 ? 0.7 : candidate.freshnessDays <= 90 ? 0.4 : 0.1;
  const confidence = candidate.renovationConfidence === "HIGH" ? 1 : candidate.renovationConfidence === "MEDIUM" ? 0.65 : 0;
  return Math.max(0.01, freshness * confidence * Math.max(0.25, candidate.similarityScore / 100));
}

function weightedQuantile(values: Array<{ value: number; weight: number }>, percentile: number): number | null {
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  if (!total) return null;
  let target = total * percentile;
  for (const item of values) { target -= item.weight; if (target <= 0) return item.value; }
  return values.at(-1)?.value ?? null;
}

function distance(subject: ArvSubject, candidate: ResaleCompRecord): number | null {
  if (subject.latitude == null || subject.longitude == null || candidate.latitude == null || candidate.longitude == null) return null;
  const rad = Math.PI / 180;
  const dLat = (candidate.latitude - subject.latitude) * rad;
  const dLon = (candidate.longitude - subject.longitude) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(subject.latitude * rad) * Math.cos(candidate.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function ageDays(value: string | null | undefined, now: number): number | null { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 86_400_000) : null; }
function sameStreet(left: string | null, right: string | null): boolean { if (!left || !right) return false; return normalize(left).replace(/\d+[a-z]?/g, "").trim() === normalize(right).replace(/\d+[a-z]?/g, "").trim(); }
function sameValue(left: string | null, right: string | null): boolean { return Boolean(left && right && normalize(left) === normalize(right)); }
function sameCity(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}
function isTenement(value: string | null): boolean { return Boolean(value && /kamienic|tenement/i.test(value)); }
function isNonTenement(value: string | null | undefined): boolean { return Boolean(value && !isTenement(value)); }
function normalize(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim(); }
