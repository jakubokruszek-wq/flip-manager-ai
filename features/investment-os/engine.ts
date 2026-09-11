import { calculateUnderwriting } from "../flip-finder/underwriting.ts";
import type { BuildDealInput, CanonicalDeal, CeoResult, DealFacts, DirectorOutput, FactValue, MarketResult, ProvenanceEntry, VerifyResult } from "./types";

export const MATERIAL_FACTS: Array<keyof DealFacts> = ["askingPrice", "areaM2", "rooms", "district", "street", "buildingType", "condition", "ownership"];
export const DIRECTOR_DEPENDENCIES = {
  SCOUT: [], VERIFY: ["SCOUT"], MARKET: ["VERIFY"], UNDERWRITER: ["MARKET", "VERIFY"], CEO: ["UNDERWRITER", "MARKET", "VERIFY"],
} as const;

export function buildCanonicalDeal(input: BuildDealInput): CanonicalDeal {
  const facts = buildFacts(input);
  const factsFingerprint = fingerprint(facts);
  const provenance = factProvenance(facts);
  const scout = output("SCOUT", fingerprint({ listingId: input.listing.id, source: input.listing.source, sourceUrl: input.listing.sourceUrl }), input.now, 100, {
    listingId: input.listing.id, source: facts.source.effectiveValue, sourceUrl: facts.sourceUrl.effectiveValue, lifecycleStatus: input.listing.lifecycleStatus,
  }, [], [], [], provenance.filter((item) => ["source", "sourceUrl", "postId"].includes(item.field)));
  const verifyResult = verifyFacts(facts, input.listing.identityExact);
  const verify = output("VERIFY", fingerprint({ facts, identityExact: input.listing.identityExact }), input.now, verifyResult.confidence, verifyResult.result,
    [...verifyResult.result.missingCriticalFields, ...verifyResult.result.missingOptionalFields], verifyResult.warnings, verifyResult.reasons, provenance);
  const market = buildMarket(facts, input.market, input.overrides.resalePerM2, input.now);
  const underwriting = buildUnderwriter(input, facts, market, verify);
  const ceo = buildCeo(input, verify, market, underwriting);
  const stage = ceo.status === "COMPLETE" ? "DECISION_READY" : underwriting.status === "COMPLETE" ? "UNDERWRITTEN" : market.status === "COMPLETE" ? "MARKET_READY" : verify.status === "COMPLETE" ? "VERIFIED" : "VERIFYING";
  return { id: input.dealId, listingId: input.listing.id, stage, factsFingerprint, facts, scout, verify, market, underwriting, ceo, createdAt: input.createdAt ?? input.now, updatedAt: input.now };
}

export function downstreamForChange(changed: Array<keyof DealFacts> | ["MARKET_ASSUMPTION"] | ["UNDERWRITING_SETTINGS"]): Array<"VERIFY" | "MARKET" | "UNDERWRITER" | "CEO"> {
  if (changed[0] === "MARKET_ASSUMPTION") return ["MARKET", "UNDERWRITER", "CEO"];
  if (changed[0] === "UNDERWRITING_SETTINGS") return ["UNDERWRITER", "CEO"];
  const material = (changed as Array<keyof DealFacts>).some((field) => MATERIAL_FACTS.includes(field));
  return material ? ["VERIFY", "MARKET", "UNDERWRITER", "CEO"] : ["VERIFY", "CEO"];
}

export function fingerprintsEqual(left: CanonicalDeal, right: CanonicalDeal): boolean {
  return left.factsFingerprint === right.factsFingerprint && left.verify.inputFingerprint === right.verify.inputFingerprint && left.market.inputFingerprint === right.market.inputFingerprint && left.underwriting.inputFingerprint === right.underwriting.inputFingerprint && left.ceo.inputFingerprint === right.ceo.inputFingerprint;
}

function buildFacts(input: BuildDealInput): DealFacts {
  const l = input.listing; const o = input.overrides;
  const field = <T>(sourceValue: T | null, overrideValue: T | null | undefined, derived = false): FactValue<T> => {
    const hasOverride = overrideValue !== undefined && overrideValue !== null;
    const effectiveValue = hasOverride ? overrideValue! : sourceValue;
    return { sourceValue, overrideValue: hasOverride ? overrideValue! : null, effectiveValue, provenance: hasOverride ? "MANUAL_OVERRIDE" : effectiveValue === null ? "UNKNOWN" : derived ? "DERIVED" : "EXTRACTED", confidence: effectiveValue === null ? 0 : hasOverride ? 100 : 90 };
  };
  const pricePerM2 = l.askingPricePerM2 ?? (positive(l.askingPrice) !== null && positive(l.areaM2) !== null ? money(l.askingPrice! / l.areaM2!) : null);
  return {
    city: field(l.city, stringOverride(o.city)), district: field(l.district, stringOverride(o.district)), street: field(l.street, stringOverride(o.street)),
    areaM2: field(l.areaM2, numberOverride(o.areaM2)), rooms: field(l.rooms, numberOverride(o.rooms)), floor: field(l.floor, stringOverride(o.floor)), floorsTotal: field(l.floorsTotal, stringOverride(o.floorsTotal)),
    buildingType: field(l.buildingType, stringOverride(o.buildingType)), yearBuilt: field(l.yearBuilt, numberOverride(o.yearBuilt)), ownership: field(l.ownership, stringOverride(o.ownership)), condition: field(l.condition, stringOverride(o.condition)),
    monthlyFee: field(l.monthlyFee, numberOverride(o.monthlyFee)), askingPrice: field(l.askingPrice, numberOverride(o.askingPrice)), askingPricePerM2: field(pricePerM2, undefined, true),
    source: field(l.source, undefined), sourceUrl: field(l.sourceUrl, undefined), postId: field(l.externalListingId, undefined), galleryStatus: field(l.galleryStatus, undefined), imageCount: field(l.imageCount, undefined),
  };
}

function verifyFacts(facts: DealFacts, identityExact: boolean): { result: VerifyResult; confidence: number; warnings: string[]; reasons: string[] } {
  const critical: string[] = []; const optional: string[] = []; const verified: string[] = [];
  for (const name of ["askingPrice", "areaM2", "rooms", "city"] as const) (facts[name].effectiveValue == null ? critical : verified).push(name);
  for (const name of ["district", "street", "buildingType", "floor", "floorsTotal", "ownership", "condition", "monthlyFee"] as const) (facts[name].effectiveValue == null ? optional : verified).push(name);
  if (!identityExact) critical.unshift("identity"); else verified.unshift("identity");
  const confidence = clamp(100 - critical.length * 18 - optional.length * 4, 0, 100);
  return { result: { verificationStatus: critical.length ? "INCOMPLETE" : "VERIFIED", verifiedFacts: verified, missingCriticalFields: critical, missingOptionalFields: optional, conflicts: [] }, confidence,
    warnings: optional.map((field) => `Brak pola opcjonalnego: ${field}`), reasons: critical.length ? ["VERIFY_CRITICAL_FACTS_MISSING"] : ["VERIFY_FACTS_CONFIRMED"] };
}

function buildMarket(facts: DealFacts, evidence: BuildDealInput["market"], resaleOverride: number | null | undefined, now: string): DirectorOutput<MarketResult> {
  const area = positive(facts.areaM2.effectiveValue); const override = positive(resaleOverride);
  const selected = override === null ? evidence : { id: null, matchedBy: "DEAL_OVERRIDE", low: money(override * .95), base: override, high: money(override * 1.05), confidence: 65, provenance: "USER_ASSUMPTION" as const, compCount: 0 };
  const inputFingerprint = fingerprint({ area, selected });
  if (area === null) return output<MarketResult>("MARKET", inputFingerprint, now, 0, null, ["areaM2"], [], ["MARKET_AREA_MISSING"], [] , "BLOCKED");
  if (!selected) return output<MarketResult>("MARKET", inputFingerprint, now, 0, null, ["resaleAssumption"], [], ["RESALE_ASSUMPTION_MISSING"], [], "BLOCKED");
  const result: MarketResult = { resalePricePerM2Low: selected.low, resalePricePerM2Base: selected.base, resalePricePerM2High: selected.high, resaleValueLow: money(area * selected.low), resaleValueBase: money(area * selected.base), resaleValueHigh: money(area * selected.high), assumptionMatchedBy: selected.matchedBy, assumptionId: selected.id, compCount: selected.compCount };
  return output("MARKET", inputFingerprint, now, selected.confidence, result, [], selected.confidence < 50 ? ["Niska pewność danych rynkowych"] : [], [selected.compCount ? "MARKET_RESALE_COMPS_USED" : "MARKET_ASSUMPTION_USED"], [{ field: "resalePricePerM2", provenance: selected.provenance, sourceId: selected.id }]);
}

function buildUnderwriter(input: BuildDealInput, facts: DealFacts, market: DirectorOutput<MarketResult>, verify: DirectorOutput<VerifyResult>) {
  const fp = fingerprint({ facts, market: market.result, settings: input.settings, overrides: input.overrides });
  if (market.status !== "COMPLETE" || !market.result) return output<ReturnType<typeof calculateUnderwriting>>("UNDERWRITER", fp, input.now, 0, null, market.missingFields, market.warnings, ["UNDERWRITING_MARKET_BLOCKED"], [], "BLOCKED");
  const result = calculateUnderwriting({ listingId: input.listing.id, source: input.listing.source, sourceUrl: input.listing.sourceUrl, lifecycleStatus: input.listing.lifecycleStatus, decisionBucket: input.listing.decisionBucket, manualDecision: input.listing.manualDecision, city: facts.city.effectiveValue, district: facts.district.effectiveValue, street: facts.street.effectiveValue, areaM2: facts.areaM2.effectiveValue, rooms: facts.rooms.effectiveValue, floor: facts.floor.effectiveValue, floorsTotal: facts.floorsTotal.effectiveValue, buildingType: facts.buildingType.effectiveValue, yearBuilt: facts.yearBuilt.effectiveValue, ownership: facts.ownership.effectiveValue, condition: facts.condition.effectiveValue, monthlyFee: facts.monthlyFee.effectiveValue, askingPrice: facts.askingPrice.effectiveValue, askingPricePerM2: facts.askingPricePerM2.effectiveValue, resalePerM2: { low: market.result.resalePricePerM2Low, base: market.result.resalePricePerM2Base, high: market.result.resalePricePerM2High, provenance: market.provenance[0]?.provenance ?? "MARKET_ASSUMPTION", confidence: market.confidence }, priceOverride: null, resalePerM2Override: null, renovationPerM2Override: numberOverride(input.overrides.renovationPerM2), holdingMonthsOverride: numberOverride(input.overrides.holdingMonths), additionalCostsOverride: numberOverride(input.overrides.additionalCosts), galleryAvailable: (facts.imageCount.effectiveValue ?? 0) > 0 }, input.settings);
  return output("UNDERWRITER", fp, input.now, Math.round((verify.confidence + market.confidence) / 2), result, result.missingFields, result.redFlags, ["UNDERWRITING_COMPLETE"], Object.entries(result.provenance).map(([field, provenance]) => ({ field, provenance })));
}

function buildCeo(input: BuildDealInput, verify: DirectorOutput<VerifyResult>, market: DirectorOutput<MarketResult>, underwriting: ReturnType<typeof buildUnderwriter>): DirectorOutput<CeoResult> {
  const fp = fingerprint({ verify: verify.inputFingerprint, market: market.inputFingerprint, underwriting: underwriting.inputFingerprint, manual: input.listing.manualDecision, lifecycle: input.listing.lifecycleStatus });
  if (!underwriting.result) return output("CEO", fp, input.now, Math.min(verify.confidence, market.confidence), { decision: input.listing.manualDecision === "REJECTED" ? "REJECT" : "REVIEW", action: input.listing.manualDecision === "REJECTED" ? "ODRZUĆ" : "HOLD / ZBIERZ DANE", headline: input.listing.manualDecision === "REJECTED" ? "Oferta odrzucona ręcznie" : "Uzupełnij dane przed decyzją", openingOffer: null, targetPurchasePrice: null, maxPurchasePrice: null, expectedProfitBase: null, expectedProfitConservative: null, flipScore: 0, confidence: Math.min(verify.confidence, market.confidence), strengths: [], risks: [...verify.warnings, ...market.warnings], missingBeforeViewing: verify.result?.missingCriticalFields ?? [], missingBeforePurchase: verify.result?.missingOptionalFields ?? [] }, [...verify.missingFields, ...market.missingFields], [...verify.warnings, ...market.warnings], [input.listing.manualDecision === "REJECTED" ? "CEO_MANUAL_REJECT" : "CEO_DEPENDENCY_BLOCKED"], [], input.listing.manualDecision === "REJECTED" ? "COMPLETE" : "BLOCKED");
  const u = underwriting.result; const decision = u.decision; const action: CeoResult["action"] = decision === "REJECT" ? "ODRZUĆ" : decision === "TOO_EXPENSIVE" ? "NEGOCJUJ" : decision === "HOT" ? "KUP" : decision === "GOOD" ? "JEDŹ OBEJRZEĆ" : "HOLD / ZBIERZ DANE";
  const openingOffer = u.targetPurchasePrice === null ? null : money(u.targetPurchasePrice * (1 - input.settings.targetNegotiationBufferPercent / 100));
  const result: CeoResult = { decision, action, headline: decision === "TOO_EXPENSIVE" ? "Dobry profil, ale cena wymaga negocjacji" : decision === "REVIEW" ? "Potencjał wymaga potwierdzenia danych" : decision === "REJECT" ? "Twardy warunek lub decyzja ręczna wyklucza ofertę" : decision === "HOT" ? "Mocny deal w granicach opłacalności" : "Warto umówić oględziny", openingOffer, targetPurchasePrice: u.targetPurchasePrice, maxPurchasePrice: u.maxPurchasePrice, expectedProfitBase: u.profitBase, expectedProfitConservative: u.profitLow, flipScore: u.flipScore, confidence: Math.min(u.confidenceScore, verify.confidence), strengths: u.strengths, risks: u.redFlags, missingBeforeViewing: verify.result?.missingCriticalFields ?? [], missingBeforePurchase: verify.result?.missingOptionalFields ?? [] };
  return output("CEO", fp, input.now, result.confidence, result, [...result.missingBeforeViewing, ...result.missingBeforePurchase], result.risks, [`CEO_${decision}`], []);
}

function output<T>(director: DirectorOutput<T>["director"], inputFingerprint: string, computedAt: string, confidence: number, result: T | null, missingFields: string[], warnings: string[], reasonCodes: string[], provenance: ProvenanceEntry[], status: DirectorOutput<T>["status"] = "COMPLETE"): DirectorOutput<T> {
  return { director, status, version: 1, inputFingerprint, computedAt, confidence: clamp(confidence, 0, 100), result, missingFields: unique(missingFields), warnings: unique(warnings), reasonCodes: unique(reasonCodes), provenance };
}
function factProvenance(facts: DealFacts): ProvenanceEntry[] { return Object.entries(facts).map(([field, value]) => ({ field, provenance: value.provenance })); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function stringOverride(value: unknown): string | null | undefined { return value === undefined ? undefined : typeof value === "string" && value.trim() ? value.trim() : null; }
function numberOverride(value: unknown): number | null | undefined { return value === undefined ? undefined : typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function positive(value: number | null | undefined): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }
function money(value: number): number { return Math.round(value * 100) / 100; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
export function fingerprint(value: unknown): string { const text = stable(value); let hash = 2166136261; for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`; }
function stable(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; }
