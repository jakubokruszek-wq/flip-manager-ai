import type { FacebookIntentDecision } from "./facebook-intent";
import type { FacebookPriceQuality } from "./price-quality";

export const FACEBOOK_SEARCH_INTENTS = [
  "APARTMENT_FOR_SALE", "APARTMENT_FOR_RENT", "ROOM_FOR_RENT", "HOUSE_FOR_SALE",
  "LAND_FOR_SALE", "COMMERCIAL", "WANTED_TO_BUY", "WANTED_TO_RENT",
  "SERVICE_AD", "DISCUSSION", "UNKNOWN",
] as const;
export type FacebookSearchIntent = (typeof FACEBOOK_SEARCH_INTENTS)[number];

export const FACEBOOK_PROPERTY_TYPES = ["APARTMENT", "HOUSE", "ROOM", "LAND", "COMMERCIAL", "GARAGE", "UNKNOWN"] as const;
export type FacebookPropertyType = (typeof FACEBOOK_PROPERTY_TYPES)[number];

export const FACEBOOK_LOCATION_STATES = ["CONFIRMED", "LIKELY", "AMBIGUOUS", "OUTSIDE_SCOPE", "MISSING"] as const;
export type FacebookLocationState = (typeof FACEBOOK_LOCATION_STATES)[number];

export const FACEBOOK_FRESHNESS_STATES = ["FRESH", "AGING", "STALE", "UNKNOWN"] as const;
export type FacebookFreshnessState = (typeof FACEBOOK_FRESHNESS_STATES)[number];

export const FACEBOOK_AVAILABILITY_STATES = ["ACTIVE", "SOLD", "RESERVED", "INACTIVE"] as const;
export type FacebookAvailabilityState = (typeof FACEBOOK_AVAILABILITY_STATES)[number];

export const FACEBOOK_DUPLICATE_STATES = ["UNIQUE", "LIKELY_DUPLICATE", "EXACT_DUPLICATE"] as const;
export type FacebookDuplicateState = (typeof FACEBOOK_DUPLICATE_STATES)[number];

export const FACEBOOK_CONTENT_QUALITY_GRADES = ["HIGH", "MEDIUM", "LOW", "NEEDS_REVIEW"] as const;
export type FacebookContentQualityGrade = (typeof FACEBOOK_CONTENT_QUALITY_GRADES)[number];

export const FACEBOOK_SEARCH_ACCEPTANCE = ["CANDIDATE", "NEEDS_REVIEW", "OUT_OF_SCOPE"] as const;
export type FacebookSearchAcceptance = (typeof FACEBOOK_SEARCH_ACCEPTANCE)[number];

// -----------------------------------------------------------------------------
// Property type — the dimension the existing intent classifier never modeled.
// "sprzedam mieszkanie w domu" describes an apartment; "sprzedam dom" does not.
// -----------------------------------------------------------------------------
const LAND_PATTERN = /\b(dzia[lł]k[\p{L}]*|grunt[\p{L}]*|parcel[\p{L}]*)\b/iu;
const COMMERCIAL_PATTERN = /\b(lokal\s+u[zż]ytkow[\p{L}]*|lokal\s+us[lł]ugow[\p{L}]*|powierzchni[aę]?\s+(?:biurow|handlow)[\p{L}]*|biuro\s+na\s+sprzeda|magazyn[\p{L}]*|sklep[\p{L}]*\s+na\s+sprzeda)\b/iu;
// A negative lookbehind excludes "w domu" (inside a house), which describes an
// apartment's building, not a house-for-sale post.
const HOUSE_PATTERN = /(?<!\bw\s)\b(dom(?:ek|u|ie|y|[oó]w)?|will[\p{L}]*|szeregow[\p{L}]*|bli[zź]niak[\p{L}]*)\b/iu;
const GARAGE_ONLY_PATTERN = /\b(gara[zż][\p{L}]*|miejsce\s+postojow[\p{L}]*)\b/iu;
const APARTMENT_PATTERN = /\b(mieszkani[\p{L}]*|kawalerk[\p{L}]*|apartament[\p{L}]*|\bm[2-6]\b)\b/iu;
// A single room, not a room-count mention: "pokój dla studentki" / "wynajmę
// pokój" is a room; "3 pokoje" / "2-pokojowe" is an apartment's layout.
const ROOM_PATTERN = /(?<!\d[\s-])\bpok(?:[oó]j|oju|oik)[\p{L}]*\b(?!\s*(?:z\s+kuchni|,?\s*kuchni))/iu;
const ROOM_RENTAL_CONTEXT = /\b(dla\s+student|wynajm[\p{L}]*\s+pok|pok[\p{L}]*\s+(?:do\s+wynaj|w\s+mieszkani)|wsp[oó][lł]lokator[\p{L}]*)\b/iu;

export function classifyFacebookPropertyType(text: string): FacebookPropertyType {
  const value = text ?? "";
  if (LAND_PATTERN.test(value)) return "LAND";
  if (COMMERCIAL_PATTERN.test(value)) return "COMMERCIAL";
  if (HOUSE_PATTERN.test(value)) return "HOUSE";
  if (ROOM_PATTERN.test(value) && (ROOM_RENTAL_CONTEXT.test(value) || !APARTMENT_PATTERN.test(value))) return "ROOM";
  if (APARTMENT_PATTERN.test(value)) return "APARTMENT";
  if (GARAGE_ONLY_PATTERN.test(value)) return "GARAGE";
  return "UNKNOWN";
}

// -----------------------------------------------------------------------------
// Combined search intent — reuses the already-tested SELL/BUY/RENT/SERVICE
// classifier from facebook-intent.ts and layers property type on top. Never
// re-derives sale-vs-rent itself; that logic already exists and is guarded.
// -----------------------------------------------------------------------------
export function classifyFacebookSearchIntent(text: string, intent: Pick<FacebookIntentDecision, "intent">): FacebookSearchIntent {
  const propertyType = classifyFacebookPropertyType(text);
  switch (intent.intent) {
    case "BUY_PROPERTY": return "WANTED_TO_BUY";
    case "RENT_WANTED": return "WANTED_TO_RENT";
    case "SERVICE": return "SERVICE_AD";
    case "RENT_OFFER": return propertyType === "ROOM" ? "ROOM_FOR_RENT" : "APARTMENT_FOR_RENT";
    case "SELL_PROPERTY":
      if (propertyType === "HOUSE") return "HOUSE_FOR_SALE";
      if (propertyType === "LAND") return "LAND_FOR_SALE";
      if (propertyType === "COMMERCIAL") return "COMMERCIAL";
      if (propertyType === "ROOM") return "UNKNOWN"; // selling a single room is not a modeled case; stays reviewable
      return "APARTMENT_FOR_SALE";
    case "OTHER": return "DISCUSSION";
    default: return "UNKNOWN";
  }
}

// -----------------------------------------------------------------------------
// Availability — sold/reserved/inactive signals. Never deletes; only labels.
// -----------------------------------------------------------------------------
const SOLD_PATTERN = /\b(sprzedan[ey]|sprzedano|ju[zż]\s+sprzedane)\b/iu;
const RESERVED_PATTERN = /\b(zarezerwowan[ey]|rezerwacj[\p{L}]*)\b/iu;
const INACTIVE_PATTERN = /\b(nieaktualn[ey]|aktualizacja\s*:?\s*nieaktualne|og[lł]oszenie\s+nieaktualne)\b/iu;

export function classifyFacebookAvailability(text: string): FacebookAvailabilityState {
  const value = text ?? "";
  if (SOLD_PATTERN.test(value)) return "SOLD";
  if (RESERVED_PATTERN.test(value)) return "RESERVED";
  if (INACTIVE_PATTERN.test(value)) return "INACTIVE";
  return "ACTIVE";
}

// -----------------------------------------------------------------------------
// Freshness — deterministic from an actual timestamp, never inferred from text.
// -----------------------------------------------------------------------------
export function classifyFacebookFreshness(publishedAt: string | null, now: number = Date.now()): FacebookFreshnessState {
  if (!publishedAt) return "UNKNOWN";
  const parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed)) return "UNKNOWN";
  const ageDays = (now - parsed) / 86_400_000;
  if (ageDays < 0) return "UNKNOWN";
  if (ageDays <= 7) return "FRESH";
  if (ageDays <= 30) return "AGING";
  return "STALE";
}

// -----------------------------------------------------------------------------
// Location state — wraps the app's existing city/district resolution rather
// than re-implementing it. `targetCity` is optional: pass it only where a
// filter's configured city is actually known.
// -----------------------------------------------------------------------------
export function classifyFacebookLocationState(input: { city: string | null; district: string | null; neighborhood: string | null; conflict?: boolean; targetCity?: string | null }): FacebookLocationState {
  if (input.conflict) return "AMBIGUOUS";
  if (!input.city) return "MISSING";
  if (input.targetCity && normalizeForCompare(input.city) !== normalizeForCompare(input.targetCity)) return "OUTSIDE_SCOPE";
  return input.district || input.neighborhood ? "CONFIRMED" : "LIKELY";
}

function normalizeForCompare(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[lł]/gi, "l").toLocaleLowerCase("pl-PL").trim();
}

// -----------------------------------------------------------------------------
// Duplicate classification — EXACT via canonical URL/post id equality (the
// signal `findExisting` in server.ts already keys on), LIKELY via the existing
// fuzzy price+area+location matcher. Never merges destructively.
// -----------------------------------------------------------------------------
export type FacebookDuplicateCheckTarget = { normalizedUrl: string | null; externalId: string | null; price: number | null; area: number | null; neighborhood: string | null; district: string | null; street: string | null };
export type FacebookDuplicateCheckCandidate = { normalizedUrl: string | null; externalId: string | null; price: number | null; area: number | null; district: string | null; address: string | null };

export function classifyFacebookDuplicate(target: FacebookDuplicateCheckTarget, candidate: FacebookDuplicateCheckCandidate, isLikelySameProperty: (target: FacebookDuplicateCheckTarget, candidate: FacebookDuplicateCheckCandidate) => boolean): FacebookDuplicateState {
  if (target.normalizedUrl && candidate.normalizedUrl && target.normalizedUrl === candidate.normalizedUrl) return "EXACT_DUPLICATE";
  if (target.externalId && candidate.externalId && target.externalId === candidate.externalId) return "EXACT_DUPLICATE";
  return isLikelySameProperty(target, candidate) ? "LIKELY_DUPLICATE" : "UNIQUE";
}

// -----------------------------------------------------------------------------
// Content quality — data completeness/trustworthiness, deliberately not a Flip
// Score. Never blocks display on its own; only informs a review badge.
// -----------------------------------------------------------------------------
export function assessFacebookContentQuality(input: {
  searchIntent: FacebookSearchIntent;
  propertyType: FacebookPropertyType;
  priceStatus: FacebookPriceQuality["status"];
  areaKnown: boolean;
  locationState: FacebookLocationState;
  freshness: FacebookFreshnessState;
  availability: FacebookAvailabilityState;
}): FacebookContentQualityGrade {
  if (input.availability !== "ACTIVE") return "NEEDS_REVIEW";
  if (input.searchIntent === "UNKNOWN") return "NEEDS_REVIEW";
  const saleIntentConfirmed = input.searchIntent === "APARTMENT_FOR_SALE";
  const propertyTypeKnown = input.propertyType !== "UNKNOWN";
  const priceOk = input.priceStatus === "VERIFIED" || input.priceStatus === "LIKELY";
  const locationOk = input.locationState === "CONFIRMED" || input.locationState === "LIKELY";
  const signals = [saleIntentConfirmed, propertyTypeKnown, priceOk, input.areaKnown, locationOk].filter(Boolean).length;

  if (input.priceStatus === "SUSPECT" || input.locationState === "AMBIGUOUS") return "NEEDS_REVIEW";
  if (signals === 5 && input.freshness !== "STALE") return "HIGH";
  if (signals >= 3) return "MEDIUM";
  if (signals >= 1) return "LOW";
  return "NEEDS_REVIEW";
}

// -----------------------------------------------------------------------------
// Search acceptance gate — decides whether a post should flow as a normal
// apartment-sale candidate. Ambiguity always resolves to NEEDS_REVIEW, never
// a fabricated classification and never a silent discard.
// -----------------------------------------------------------------------------
export function facebookSearchAcceptance(input: {
  searchIntent: FacebookSearchIntent;
  sourceValid: boolean;
  locationState: FacebookLocationState;
  availability: FacebookAvailabilityState;
}): FacebookSearchAcceptance {
  if (input.availability !== "ACTIVE") return "NEEDS_REVIEW";
  if (input.searchIntent === "UNKNOWN") return "NEEDS_REVIEW";
  if (input.searchIntent !== "APARTMENT_FOR_SALE") return "OUT_OF_SCOPE";
  if (!input.sourceValid) return "NEEDS_REVIEW";
  if (input.locationState === "OUTSIDE_SCOPE") return "OUT_OF_SCOPE";
  if (input.locationState === "AMBIGUOUS") return "NEEDS_REVIEW";
  return "CANDIDATE";
}
