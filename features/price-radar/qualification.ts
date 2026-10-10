import { assessBuildingType } from "@/features/flip-finder/listing-attribute-extraction";
import {
  DEFAULT_RADAR_DISTRICTS,
  RADAR_QUALIFICATION_REJECTION_REASONS,
  type RadarBuildingType,
  type RadarQualificationRejectionReason,
  type RadarQualificationRejections,
  type RadarRenovationStatus,
} from "./types";
import type { MarketType } from "@/features/flip-finder";

/**
 * Radar's own, strict qualification -- entirely independent of Finder's
 * filter-evaluation.ts (no buy-price cap, no flip score, no ROI; Radar
 * compares offer prices for a confirmed, narrow apartment category, not
 * flip opportunities). Every criterion requires positive, confirmed
 * evidence from the listing's own fields/text; missing or ambiguous data
 * never qualifies -- it is excluded, same as a listing that fails outright.
 */

export type QualificationCandidate = {
  source: string;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number | null;
  area: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  city: string | null;
  district: string | null;
  /** Structured field from the adapter, when it has one (e.g. Otodom). Text extraction is only a fallback. */
  buildingType?: string | null;
  /** Structured field (Otodom's PropertySearchListing carries this); absent for adapters with no structured signal. */
  marketType?: string | null;
  propertyType?: string | null;
  rawPayload?: Record<string, unknown>;
  contentHash: string;
};

export type QualifiedListing = {
  buildingType: RadarBuildingType;
  marketType: MarketType;
  renovationStatus: RadarRenovationStatus;
  district: string;
  pricePerSqm: number;
};

export type QualificationResult =
  | ({ qualified: true } & QualifiedListing)
  | { qualified: false; reason: RadarQualificationRejectionReason };

function reject(reason: RadarQualificationRejectionReason): QualificationResult {
  return { qualified: false, reason };
}

export function recordRadarQualificationRejection(
  rejections: RadarQualificationRejections,
  source: string,
  reason: RadarQualificationRejectionReason,
): void {
  const sourceCounts = rejections[source] ?? (rejections[source] = {});
  sourceCounts[reason] = (sourceCounts[reason] ?? 0) + 1;
}

/** Drops malformed/unknown checkpoint values before returning them to the UI. */
export function normalizeRadarQualificationRejections(value: unknown): RadarQualificationRejections {
  if (!isRecord(value)) return {};
  const allowedReasons = new Set<string>(RADAR_QUALIFICATION_REJECTION_REASONS);
  const result: RadarQualificationRejections = {};
  for (const [source, rawCounts] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-z0-9_]{1,64}$/iu.test(source) || !isRecord(rawCounts)) continue;
    const counts: RadarQualificationRejections[string] = {};
    for (const [reason, rawCount] of Object.entries(rawCounts)) {
      if (!allowedReasons.has(reason) || !Number.isSafeInteger(rawCount) || Number(rawCount) <= 0) continue;
      counts[reason as RadarQualificationRejectionReason] = Number(rawCount);
    }
    if (Object.keys(counts).length) result[source] = counts;
  }
  return result;
}

export function isRadarQualificationRejectionReason(value: unknown): value is RadarQualificationRejectionReason {
  return typeof value === "string" && RADAR_QUALIFICATION_REJECTION_REASONS.includes(value as RadarQualificationRejectionReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const RENTAL_PATTERN = /wynajem|wynajm\p{L}*|do wynaj\p{L}*|najem\b|czynsz najmu|sublokat\p{L}*|pokój\s+(?:do\s+wynaj\p{L}*|w\s+mieszkaniu)/iu;
const SHARE_PATTERN = /\budzia\p{L}*\s+we?\s+wsp\p{L}*w\p{L}*asno\p{L}*/iu;
const COMMERCIAL_PATTERN = /lokal\s+u\p{L}*ytkow\p{L}*|lokal\s+us\p{L}*ug\p{L}*|biuro\s+na\s+sprzeda\p{L}*|magazyn|hala\s+produkcyj\p{L}*/iu;
const PLOT_PATTERN = /dzia\p{L}*k\p{L}*\s+(?:budowlan\p{L}*|rolna\p{L}*|inwestycyjn\p{L}*)/iu;
const HOUSE_LIKE_PATTERN = /\bdom\p{L}*\b|szeregow\p{L}*|bli\p{L}*niacz\p{L}*|segment\p{L}*\b/iu;
const BULK_INVESTMENT_PATTERN = /ceny\s+mieszka\p{L}*\s+od|harmonogram\s+inwestycj\p{L}*|wybierz\s+(?:swoje\s+)?mieszkanie|r\p{L}*\p{L}*ne\s+metra\p{L}*e\s+do\s+wyboru|kilka\s+mieszka\p{L}*\s+w\s+ofercie|wiele\s+lokali\s+w\s+ofercie/iu;
const APARTMENT_PATTERN = /\bmieszkan\p{L}*\b/iu;
const APARTMENT_NEGATION_PATTERN = /(?:to\s+nie|nie\s+jest|brak)\s+(?:konkretnego\s+)?mieszkan\p{L}*/iu;

const PRIMARY_MARKET_PATTERN = /rynek\s+pierwotny|od\s+dewelopera|nowa\s+inwestycja|inwestycja\s+deweloperska/iu;
const SECONDARY_MARKET_PATTERN = /rynek\s+wt\p{L}*rny/iu;
const DEVELOPER_STATE_PATTERN = /stan\s+deweloperski|do\s+wyko\p{L}*czenia|bez\s+wyko\p{L}*czenia/iu;
const NEEDS_RENOVATION_PATTERN = /do\s+remontu|wymaga\s+remontu|do\s+odnowienia|surowy\s+stan/iu;
const TURNKEY_PATTERN = /wyko\p{L}*czon\p{L}*\s+pod\s+klucz/iu;
const FRESH_FULL_RENOVATION_PATTERN = /(?:świeżo|niedawno)\s+po\s+(?:generalnym|kapitalnym)\s+remoncie|(?:generalny|kapitalny)\s+remont\s+(?:zakończon\p{L}*\s+)?w\s+20(?:2[1-9]|3\d)|(?:po\s+)?(?:generalnym|kapitalnym)\s+remoncie\s+(?:z\s+)?20(?:2[1-9]|3\d)/iu;
// A listing can establish that the completed full renovation is still unused
// without stating its calendar year. Require all three facts in the offer:
// the general renovation, explicit non-occupancy since completion, and an
// independently stated ready-to-move condition. This is deliberately narrow;
// a generic "po remoncie" or a recent publication date alone is insufficient.
const UNUSED_AFTER_FULL_RENOVATION_PATTERN = /generaln\p{L}*\s+remon\p{L}*[\s\S]{0,140}?\bpo\s+(?:jego\s+)?zakończeni\p{L}*[\s\S]{0,80}?\bnie\s+(?:był|było|byli)\s+(?:jeszcze\s+)?zamieszk\p{L}*/iu;
const MOVE_IN_READY_PATTERN = /gotow\p{L}*\s+do\s+zamieszkan\p{L}*|do\s+natychmiastow\p{L}*\s+wprowadzen\p{L}*/iu;
const RENOVATION_CONFLICT_PATTERN = /(?:do\s+remontu|wymaga\s+remontu|remont\s+(?:do\s+wykonania|konieczny|planowan\p{L}*|częściow\p{L}*)|w\s+trakcie\s+remontu|bez\s+generalnego\s+remontu|\bnie\s+po\s+(?:generalnym|kapitalnym)\s+remoncie)/iu;
const STARTING_PRICE_PATTERN = /(?:^|[\s:])od\s+\d[\d\s.,]*\s*(?:zł|PLN)/iu;

function normalizeDistrict(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = DEFAULT_RADAR_DISTRICTS.find((district) => district.toLocaleLowerCase("pl-PL") === trimmed.toLocaleLowerCase("pl-PL"));
  return match ?? null;
}

function resolveBuildingTypeForRadar(candidate: QualificationCandidate, text: string): RadarBuildingType | null {
  const assessment = assessBuildingType(candidate.buildingType, candidate.title, candidate.description);
  const resolved = assessment.conflict ? null : assessment.value;
  if (resolved === "blok" || resolved === "apartamentowiec") return resolved;
  // A structured value naming a disqualifying type (dom/kamienica/...) is
  // itself confirmation this is NOT a qualifying apartment -- handled by the
  // explicit exclusion checks in qualifyRadarCandidate using the free text,
  // not here; this function only ever returns a positive blok/apartamentowiec
  // confirmation or null (unknown).
  void text;
  return null;
}

function resolveMarketType(candidate: QualificationCandidate, text: string): MarketType | null {
  const structured = candidate.marketType?.trim().toLocaleLowerCase("pl-PL") ?? null;
  const isPrimary = PRIMARY_MARKET_PATTERN.test(text);
  const isSecondary = SECONDARY_MARKET_PATTERN.test(text);
  if (isPrimary && isSecondary) return null;
  if (structured === "primary" || structured === "secondary") {
    if ((structured === "primary" && isSecondary) || (structured === "secondary" && isPrimary)) return null;
    return structured;
  }
  if (isPrimary) return "primary";
  if (isSecondary) return "secondary";
  return null; // absent or contradictory text signal -- unknown, never guessed
}

/** The phrase "pod wynajem" is an investment use, not a rental transaction. */
export function isRadarRentalTransactionText(value: string | null | undefined): boolean {
  return RENTAL_PATTERN.test((value ?? "").replace(/\bpod\s+wynajem\b/giu, " "));
}

export function inspectRadarFinishEvidence(text: string): {
  fullRenovation: boolean;
  freshFullRenovation: boolean;
  moveInReady: boolean;
  turnkey: boolean;
} {
  const fullRenovation = /(?:generaln\p{L}*|kapitaln\p{L}*)\s+remon\p{L}*/iu.test(text);
  return {
    fullRenovation,
    freshFullRenovation: FRESH_FULL_RENOVATION_PATTERN.test(text) || UNUSED_AFTER_FULL_RENOVATION_PATTERN.test(text),
    moveInReady: MOVE_IN_READY_PATTERN.test(text) || /gotow\p{L}*\s+do\s+wprowadzen\p{L}*/iu.test(text),
    turnkey: TURNKEY_PATTERN.test(text),
  };
}

type RadarPreflightCandidate = Pick<QualificationCandidate, "title" | "description" | "buildingType" | "propertyType" | "rawPayload">;

/**
 * Returns only exclusions that can be proven from the result card alone.
 * Missing fields are intentionally not rejected here because a detail page
 * may confirm them; the same helper is also used by the final qualifier so
 * Finder/Radar parsing cannot disagree about explicit sale-vs-rental text.
 */
export function preflightRadarCandidateRejection(candidate: RadarPreflightCandidate): RadarQualificationRejectionReason | null {
  const payload = candidate.rawPayload ?? {};
  if (payload.priceIsStartingAt === true || payload.priceKind === "from" || payload.priceUnit === "per_sqm") return "price_is_not_total_offer_price";
  const text = `${candidate.title ?? ""} ${candidate.description ?? ""}`;
  if (STARTING_PRICE_PATTERN.test(text)) return "price_is_starting_price";
  if (isRadarRentalTransactionText(text)) return "rental";
  if (SHARE_PATTERN.test(text)) return "share";
  if (COMMERCIAL_PATTERN.test(text)) return "commercial";
  if (PLOT_PATTERN.test(text)) return "plot";
  if (assessBuildingType(candidate.buildingType, candidate.title, candidate.description).tenementEvidence) return "tenement_excluded";
  if (HOUSE_LIKE_PATTERN.test(text)) return "house_excluded";
  if (BULK_INVESTMENT_PATTERN.test(text)) return "bulk_investment_ad";
  const structuredPropertyType = candidate.propertyType?.trim().toLocaleLowerCase("pl-PL") ?? null;
  if (APARTMENT_NEGATION_PATTERN.test(text) || (structuredPropertyType && !["apartment", "mieszkanie", "flat"].includes(structuredPropertyType))) return "apartment_not_confirmed";
  return null;
}

export function qualifyRadarCandidate(candidate: QualificationCandidate): QualificationResult {
  if ((candidate.source === "oferty_net" || candidate.source === "domiporta") && candidate.rawPayload?.detailVerified !== true) return reject("detail_not_confirmed");
  if (candidate.price === null || !Number.isFinite(candidate.price) || candidate.price <= 0) return reject("price_missing");
  if (candidate.area === null || !Number.isFinite(candidate.area) || candidate.area <= 0) return reject("area_missing");
  const payload = candidate.rawPayload ?? {};
  if (payload.priceIsStartingAt === true || payload.priceKind === "from" || payload.priceUnit === "per_sqm") return reject("price_is_not_total_offer_price");
  const text = `${candidate.title ?? ""} ${candidate.description ?? ""}`;
  if (STARTING_PRICE_PATTERN.test(text)) return reject("price_is_starting_price");
  // The total asking price and verified floor area are authoritative. A
  // portal's denormalized price/m² value can be stale or refer to a different
  // unit, so it must never replace their ratio in the Radar sample.
  const pricePerSqm = candidate.price / candidate.area;
  if (!Number.isFinite(pricePerSqm) || pricePerSqm <= 0) return reject("price_per_sqm_invalid");

  const district = normalizeDistrict(candidate.district);
  if (!district) return reject("district_not_confirmed");
  if (!candidate.city || candidate.city.trim().toLocaleLowerCase("pl-PL") !== "łódź") return reject("city_not_lodz");

  const preflightRejection = preflightRadarCandidateRejection(candidate);
  if (preflightRejection) return reject(preflightRejection);
  const structuredPropertyType = candidate.propertyType?.trim().toLocaleLowerCase("pl-PL") ?? null;
  if (!structuredPropertyType && !APARTMENT_PATTERN.test(text)) return reject("apartment_not_confirmed");

  const buildingType = resolveBuildingTypeForRadar(candidate, text);
  if (!buildingType) return reject("building_type_not_confirmed");

  const marketType = resolveMarketType(candidate, text);
  if (!marketType) return reject("market_type_not_confirmed");

  if (DEVELOPER_STATE_PATTERN.test(text) || NEEDS_RENOVATION_PATTERN.test(text)) return reject("unfinished_or_needs_renovation");

  const finish = inspectRadarFinishEvidence(text);
  if (marketType === "secondary") {
    if (RENOVATION_CONFLICT_PATTERN.test(text)) return reject("renovation_exclusion");
    if (!finish.freshFullRenovation || !finish.moveInReady) return reject("renovation_not_confirmed_fresh_full");
    return { qualified: true, buildingType, marketType, renovationStatus: "fresh_renovation", district, pricePerSqm };
  }

  // Primary market: must be an explicit, confirmed turnkey/finished
  // declaration -- "stan deweloperski" was already excluded above.
  if (!finish.turnkey) return reject("turnkey_not_confirmed");
  return { qualified: true, buildingType, marketType, renovationStatus: "turnkey_finish", district, pricePerSqm };
}
