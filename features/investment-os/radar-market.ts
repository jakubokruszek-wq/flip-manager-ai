import type { RadarListing } from "../price-radar/types";
import { MIN_RADAR_SAMPLE_SIZE } from "../price-radar/types";
import { normalizeConfirmedPropertyIdentity } from "../flip-finder/property-identity";
import { calculateResaleArv } from "../market-intelligence/resale-arv";
import type { ComparableListing } from "../market-intelligence/types";
import type { DealListingInput, MarketEvidence } from "./types";

export type RadarMarketAudit = { id: string; sourceUrl: string | null; accepted: boolean; reasons: string[] };
export type RadarMarketPolicy = { maximumAgeDays: number; minimumSample: number };
export const DEFAULT_RADAR_MARKET_POLICY: RadarMarketPolicy = { maximumAgeDays: 30, minimumSample: MIN_RADAR_SAMPLE_SIZE };
const norm = (v: string | null) => (v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").toLowerCase().trim();
const building = (v: string | null) => /^(block|blok)$/.test(norm(v)) ? "blok" : /^(apartment|apartamentowiec)$/.test(norm(v)) ? "apartamentowiec" : norm(v);
const validUrl = (v: string) => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };

/** Read-only adaptation of Radar's qualified, owner-scoped population. Never invent transaction or photo evidence. */
export function radarMarketEvidence(subject: DealListingInput, rows: RadarListing[], now: string, policy = DEFAULT_RADAR_MARKET_POLICY): { evidence: MarketEvidence; audit: RadarMarketAudit[] } {
  if (!Number.isFinite(policy.maximumAgeDays) || policy.maximumAgeDays <= 0 || !Number.isInteger(policy.minimumSample) || policy.minimumSample < MIN_RADAR_SAMPLE_SIZE) throw new Error("Invalid Radar comparison policy");
  const audit: RadarMarketAudit[] = [];
  const selected: ComparableListing[] = [];
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons: string[] = [];
    const age = (Date.parse(now) - Date.parse(row.collectedAt)) / 86400000;
    if (!Number.isFinite(age) || age < 0 || age > policy.maximumAgeDays) reasons.push("STALE_OR_UNKNOWN_COLLECTION_DATE");
    if (row.status !== "active" || row.excludedAt) reasons.push("REMOVED_OR_OPERATOR_EXCLUDED");
    if (row.verificationIssues?.length) reasons.push("UNRESOLVED_IDENTITY_OR_DETAIL_CONFLICT");
    if (!validUrl(row.originalUrl)) reasons.push("UNSAFE_OR_MISSING_LINK");
    if (row.originalUrl === subject.sourceUrl || row.crossSourceAlternates.some(a => a.originalUrl === subject.sourceUrl) || (row.source === subject.source && row.externalListingId === subject.externalListingId)) reasons.push("SUBJECT_SELF_COMPARISON");
    if (!subject.city || !subject.district || norm(row.city) !== norm(subject.city) || norm(row.district) !== norm(subject.district)) reasons.push("LOCATION_NOT_COMPARABLE");
    if (!subject.areaM2 || !(row.area > 0) || Math.abs(row.area - subject.areaM2) / subject.areaM2 > .15) reasons.push("AREA_MISSING_OR_OUTSIDE_15_PERCENT");
    if (!subject.rooms || row.rooms !== subject.rooms) reasons.push("ROOMS_MISSING_OR_DIFFERENT");
    if (!subject.buildingType || building(row.buildingType) !== building(subject.buildingType)) reasons.push("BUILDING_TYPE_MISSING_OR_DIFFERENT");
    // Exit scenario is a renovated secondary apartment, not developer turnkey stock.
    if (row.marketType !== "secondary" || row.renovationStatus !== "fresh_renovation") reasons.push("MARKET_OR_FINISH_NOT_COMPARABLE");
    if (!(row.price > 0) || !(row.pricePerSqm > 0) || Math.abs(row.price / row.area - row.pricePerSqm) / row.pricePerSqm > .01) reasons.push("INCONSISTENT_PRICE");
    if (row.crossSourceAlternates.some(a => Math.abs(a.area - row.area) > .5 || (a.rooms !== null && a.rooms !== row.rooms) || Math.abs(a.price - row.price) / row.price > .1)) reasons.push("CROSS_PORTAL_CONFLICT");
    const key = normalizeConfirmedPropertyIdentity(row.crossSourceIdentity) ?? `${row.source}:${row.externalListingId}`;
    if (seen.has(key)) reasons.push("CONFIRMED_DUPLICATE");
    if (!reasons.length) seen.add(key);
    audit.push({ id: row.id, sourceUrl: validUrl(row.originalUrl) ? row.originalUrl : null, accepted: reasons.length === 0, reasons });
    if (reasons.length) continue;
    selected.push({ id: row.id, title: row.title, originalUrl: row.originalUrl, normalizedUrl: row.normalizedUrl, price: row.price, area: row.area, pricePerSqm: row.pricePerSqm, rooms: row.rooms, buildingType: row.buildingType, address: null, district: row.district, city: row.city, source: row.source, lastSeenAt: row.collectedAt, similarityScore: 80, matchReasons: ["Ta sama dzielnica; mikrolokalizacja niepotwierdzona", "Metraż ±15%, zgodne pokoje i typ budynku", "Rynek wtórny, potwierdzony standard po remoncie", "Cena ofertowa; zdjęcia nie są dowodem tego adaptera"], renovationConfidence: "HIGH", renovationStatus: "RENOVATED", freshnessDays: age, distanceMeters: null, outlierReason: null });
  }
  const arv = calculateResaleArv({ area: subject.areaM2 }, selected);
  const enough = selected.length >= policy.minimumSample;
  return { audit, evidence: { id: null, matchedBy: "PRICE_RADAR", low: arv.conservativePrice && subject.areaM2 ? arv.conservativePrice / subject.areaM2 : 0, base: arv.expectedPrice && subject.areaM2 ? arv.expectedPrice / subject.areaM2 : 0, high: arv.optimisticPrice && subject.areaM2 ? arv.optimisticPrice / subject.areaM2 : 0, confidence: enough ? 70 : 30, provenance: "DERIVED", compCount: selected.length, fallbackLevel: 0, fallbackReason: enough ? "ASKING_ONLY_DISTRICT_NOT_MICROLOCATION" : "RADAR_INSUFFICIENT_INDEPENDENT_SAMPLE", confidencePenalty: 0, observedAt: selected.map(c => c.lastSeenAt).sort()[0] ?? null, evidenceId: `radar:${selected.map(c => `${c.id}:${c.price}:${c.lastSeenAt}`).sort().join("|")}`, priceEvidenceType: "ASKING", comparables: selected.map(c => ({ radarDetails: (() => { const r = rows.find(row => row.id === c.id)!; return { area: r.area, rooms: r.rooms, city: r.city, district: r.district, buildingType: r.buildingType, standard: r.renovationStatus, collectedAt: r.collectedAt, status: r.status, linkVerified: false as const, photosVerified: false as const }; })(), id: c.id, source: c.source, sourceUrl: c.originalUrl, pricePerM2: c.pricePerSqm!, similarityScore: c.similarityScore, dataQuality: 70, freshnessDays: c.freshnessDays ?? null, distanceMeters: null, adjustments: c.matchReasons, weight: .8 * ((c.freshnessDays ?? Infinity) <= 30 ? 1 : (c.freshnessDays ?? Infinity) <= 60 ? .7 : (c.freshnessDays ?? Infinity) <= 90 ? .4 : .1), outlierReason: null, priceEvidenceType: "ASKING" })), radarAudit: audit, minimumSample: policy.minimumSample } };
}
