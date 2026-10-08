import { assessBuildingType } from "@/features/flip-finder/listing-attribute-extraction";
import { DEFAULT_RADAR_DISTRICTS, type RadarBuildingType, type RadarRenovationStatus } from "./types";
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
  | { qualified: false; reason: string };

function reject(reason: string): QualificationResult {
  return { qualified: false, reason };
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
const MOVE_IN_READY_PATTERN = /gotow\p{L}*\s+do\s+zamieszkan\p{L}*|do\s+natychmiastow\p{L}*\s+wprowadzen\p{L}*/iu;
const RENOVATION_CONFLICT_PATTERN = /(?:do\s+remontu|wymaga\s+remontu|remont\s+(?:do\s+wykonania|konieczny|planowan\p{L}*|częściow\p{L}*)|w\s+trakcie\s+remontu|bez\s+generalnego\s+remontu|nie\s+po\s+(?:generalnym|kapitalnym)\s+remoncie)/iu;
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

export function qualifyRadarCandidate(candidate: QualificationCandidate): QualificationResult {
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

  if (RENTAL_PATTERN.test(text)) return reject("rental");
  if (SHARE_PATTERN.test(text)) return reject("share");
  if (COMMERCIAL_PATTERN.test(text)) return reject("commercial");
  if (PLOT_PATTERN.test(text)) return reject("plot");
  const buildingEvidence = assessBuildingType(candidate.buildingType, candidate.title, candidate.description);
  if (buildingEvidence.tenementEvidence) return reject("tenement_excluded");
  if (HOUSE_LIKE_PATTERN.test(text)) return reject("house_excluded");
  if (BULK_INVESTMENT_PATTERN.test(text)) return reject("bulk_investment_ad");
  const structuredPropertyType = candidate.propertyType?.trim().toLocaleLowerCase("pl-PL") ?? null;
  if (APARTMENT_NEGATION_PATTERN.test(text) || (structuredPropertyType && !["apartment", "mieszkanie", "flat"].includes(structuredPropertyType)) || (!structuredPropertyType && !APARTMENT_PATTERN.test(text))) return reject("apartment_not_confirmed");

  const buildingType = resolveBuildingTypeForRadar(candidate, text);
  if (!buildingType) return reject("building_type_not_confirmed");

  const marketType = resolveMarketType(candidate, text);
  if (!marketType) return reject("market_type_not_confirmed");

  if (DEVELOPER_STATE_PATTERN.test(text) || NEEDS_RENOVATION_PATTERN.test(text)) return reject("unfinished_or_needs_renovation");

  if (marketType === "secondary") {
    if (RENOVATION_CONFLICT_PATTERN.test(text)) return reject("renovation_exclusion");
    if (!FRESH_FULL_RENOVATION_PATTERN.test(text) || !MOVE_IN_READY_PATTERN.test(text)) return reject("renovation_not_confirmed_fresh_full");
    return { qualified: true, buildingType, marketType, renovationStatus: "fresh_renovation", district, pricePerSqm };
  }

  // Primary market: must be an explicit, confirmed turnkey/finished
  // declaration -- "stan deweloperski" was already excluded above.
  if (!TURNKEY_PATTERN.test(text)) return reject("turnkey_not_confirmed");
  return { qualified: true, buildingType, marketType, renovationStatus: "turnkey_finish", district, pricePerSqm };
}
