import type { FacebookListingIntent } from "../facebook-worker/types";
import type { FacebookPriceProvenance, FacebookSourceFacts } from "./types";

export const FACEBOOK_PRICE_CATEGORIES = [
  "SALE_PRICE", "PRICE_PER_M2", "RENT", "ADMIN_FEE", "CZYNSZ", "UTILITY_COST",
  "DEPOSIT", "RENOVATION_COST", "MONTHLY_PAYMENT", "OTHER_AMOUNT", "UNKNOWN_AMOUNT",
] as const;
export type FacebookPriceCategory = (typeof FACEBOOK_PRICE_CATEGORIES)[number];

export const FACEBOOK_PRICE_STATUSES = ["VERIFIED", "LIKELY", "SUSPECT", "MISSING"] as const;
export type FacebookPriceStatus = (typeof FACEBOOK_PRICE_STATUSES)[number];

export const FACEBOOK_PRICE_SOURCES = ["POST_TEXT", "STRUCTURED", "IMAGE_OCR", "MANUAL", "OTHER"] as const;
export type FacebookPriceSource = (typeof FACEBOOK_PRICE_SOURCES)[number];

export type FacebookPriceCandidate = { value: number; source: FacebookPriceSource; category: FacebookPriceCategory };

export type FacebookPriceQuality = {
  status: FacebookPriceStatus;
  category: FacebookPriceCategory;
  source: FacebookPriceSource;
  rawPriceText: string | null;
  priceContext: string | null;
  reasonCodes: string[];
  conflict: boolean;
  candidates: FacebookPriceCandidate[];
};

/** Below this, a number cannot plausibly be a real Polish apartment sale price. */
export const MIN_PLAUSIBLE_SALE_PRICE_PLN = 10_000;
/** Below this implied PLN/m², a number claiming to be a total sale price almost certainly is not one. */
export const MIN_PLAUSIBLE_PRICE_PER_M2_PLN = 500;
/** A price this close (relative) to the separately-extracted monthly fee is probably the fee itself. */
const RENT_OVERLAP_TOLERANCE = 0.02;
/** Minimum relative difference between a text-derived and an image-derived price candidate to call it a conflict. */
const CONFLICT_RELATIVE_TOLERANCE = 0.015;
/** Flip/opportunity score cap applied whenever the input price cannot be trusted. */
export const PRICE_SUSPECT_SCORE_CAP = 19;

export function isFacebookPriceSuspect(status: FacebookPriceStatus): boolean {
  return status === "SUSPECT" || status === "MISSING";
}

/**
 * Deterministic, LLM-free sanity layer over an already-extracted Facebook price.
 * Never guesses a "corrected" price and never removes data — it only classifies
 * what the number probably is and how much the pipeline should trust it.
 */
export function assessFacebookPriceQuality(input: {
  price: number | null;
  area: number | null;
  sourceFacts?: FacebookSourceFacts | null;
  listingIntent?: FacebookListingIntent;
  priceProvenance?: FacebookPriceProvenance;
  postText?: string | null;
  visionPrice?: number | null;
}): FacebookPriceQuality {
  const primarySource: FacebookPriceSource = input.priceProvenance === "VISION" ? "IMAGE_OCR" : input.priceProvenance === "HISTORICAL" ? "OTHER" : "POST_TEXT";

  if (input.price === null) {
    return { status: "MISSING", category: "UNKNOWN_AMOUNT", source: primarySource, rawPriceText: null, priceContext: null, reasonCodes: ["PRICE_MISSING"], conflict: false, candidates: [] };
  }

  const reasonCodes: string[] = [];
  const candidates: FacebookPriceCandidate[] = [{ value: input.price, source: primarySource, category: "SALE_PRICE" }];
  const { rawPriceText, priceContext } = input.postText ? locatePriceText(input.postText, input.price) : { rawPriceText: null, priceContext: null };

  let category: FacebookPriceCategory = "SALE_PRICE";
  let suspect = false;

  if (input.listingIntent === "RENT_OFFER") {
    category = "RENT";
    suspect = true;
    reasonCodes.push("PRICE_LOOKS_LIKE_RENT_INTENT");
  }

  const rent = input.sourceFacts?.administrativeRent ?? null;
  if (rent !== null && rent > 0 && Math.abs(input.price - rent) <= rent * RENT_OVERLAP_TOLERANCE) {
    if (category === "SALE_PRICE") category = "CZYNSZ";
    suspect = true;
    reasonCodes.push("PRICE_MATCHES_ADMIN_RENT");
  }

  if (input.price < MIN_PLAUSIBLE_SALE_PRICE_PLN) {
    suspect = true;
    reasonCodes.push("PRICE_BELOW_PLAUSIBLE_FLOOR");
    if (category === "SALE_PRICE") category = "OTHER_AMOUNT";
  }

  if (input.area !== null && input.area > 0 && input.price / input.area < MIN_PLAUSIBLE_PRICE_PER_M2_PLN) {
    suspect = true;
    reasonCodes.push("PRICE_PER_M2_IMPLAUSIBLE");
  }

  let conflict = false;
  if (typeof input.visionPrice === "number" && Number.isFinite(input.visionPrice) && input.visionPrice > 0 && input.visionPrice !== input.price) {
    const relativeDiff = Math.abs(input.visionPrice - input.price) / Math.max(input.price, input.visionPrice);
    if (relativeDiff > CONFLICT_RELATIVE_TOLERANCE) {
      conflict = true;
      suspect = true;
      reasonCodes.push("PRICE_CONFLICT_TEXT_VS_IMAGE");
      candidates.push({ value: input.visionPrice, source: "IMAGE_OCR", category: "SALE_PRICE" });
    }
  }

  let status: FacebookPriceStatus;
  if (suspect) {
    status = "SUSPECT";
  } else if (rawPriceText && /cena|kwota/i.test(priceContext ?? rawPriceText)) {
    status = "VERIFIED";
    reasonCodes.push("PRICE_EXPLICITLY_LABELLED");
  } else {
    status = "LIKELY";
    reasonCodes.push("PRICE_UNLABELLED_BUT_PLAUSIBLE");
  }

  return { status, category, source: primarySource, rawPriceText, priceContext, reasonCodes, conflict, candidates };
}

function locatePriceText(text: string, price: number): { rawPriceText: string | null; priceContext: string | null } {
  const normalized = text.replace(/[  ]/g, " ");
  const rounded = Math.round(price);
  const literalCandidates = [formatSpacedThousands(rounded), String(rounded)];
  for (const pattern of literalCandidates) {
    const index = normalized.indexOf(pattern);
    if (index === -1) continue;
    return windowAround(normalized, index, pattern.length);
  }
  if (rounded % 1000 === 0 && rounded > 0) {
    const match = normalized.match(new RegExp(`\\b${rounded / 1000}\\s*(?:tys\\.?|tysi(?:ąc(?:e|y)?)?)`, "i"));
    if (match && match.index !== undefined) return windowAround(normalized, match.index, match[0].length);
  }
  return { rawPriceText: null, priceContext: null };
}

function windowAround(text: string, index: number, length: number): { rawPriceText: string; priceContext: string } {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  return { rawPriceText: text.slice(index, index + length).trim(), priceContext: text.slice(start, end).trim() };
}

function formatSpacedThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export type FacebookListingQualityGrade = "COMPLETE" | "USABLE" | "NEEDS_REVIEW" | "INVALID";
export type FacebookListingQualityAssessment = {
  priceOk: boolean;
  areaOk: boolean;
  locationOk: boolean;
  sourceOk: boolean;
  listingQuality: FacebookListingQualityGrade;
};

/** Lightweight deterministic input-quality gate. INVALID means "cannot safely calculate from this", never "delete the listing". */
export function assessFacebookListingQuality(input: {
  priceQuality: FacebookPriceQuality;
  area: number | null;
  city: string | null;
  district: string | null;
  street: string | null;
  originalUrl: string | null;
}): FacebookListingQualityAssessment {
  const priceOk = input.priceQuality.status === "VERIFIED" || input.priceQuality.status === "LIKELY";
  const areaOk = input.area !== null && input.area > 0;
  const locationOk = Boolean(input.city || input.district || input.street);
  const sourceOk = Boolean(input.originalUrl);

  let listingQuality: FacebookListingQualityGrade;
  if (input.priceQuality.status === "MISSING" && !areaOk) listingQuality = "INVALID";
  else if (priceOk && areaOk && locationOk && sourceOk) listingQuality = "COMPLETE";
  else if (areaOk && input.priceQuality.status !== "MISSING") listingQuality = "USABLE";
  else listingQuality = "NEEDS_REVIEW";

  return { priceOk, areaOk, locationOk, sourceOk, listingQuality };
}

const CATEGORY_LABELS_PL: Record<FacebookPriceCategory, string> = {
  SALE_PRICE: "cena sprzedaży", PRICE_PER_M2: "cena za metr kwadratowy", RENT: "czynsz najmu",
  ADMIN_FEE: "opłata administracyjna", CZYNSZ: "czynsz", UTILITY_COST: "opłata za media",
  DEPOSIT: "kaucja", RENOVATION_COST: "koszt remontu", MONTHLY_PAYMENT: "rata",
  OTHER_AMOUNT: "inna kwota", UNKNOWN_AMOUNT: "nieustalona kwota",
};

/** UI copy for the subtle "why is this price flagged" explanation. Returns null when nothing needs explaining. */
export function facebookPriceReviewExplanation(quality: FacebookPriceQuality, price: number | null): string | null {
  if (quality.status === "MISSING") return "Nie wykryto ceny sprzedaży w tym ogłoszeniu.";
  if (quality.status !== "SUSPECT" || price === null) return null;
  const label = CATEGORY_LABELS_PL[quality.category] ?? "inna kwota";
  return `Wykryto kwotę ${formatPln(price)}, ale kontekst wskazuje, że może to być ${label}.`;
}

function formatPln(value: number): string {
  return `${new Intl.NumberFormat("pl-PL").format(Math.round(value))} zł`;
}

/**
 * Reads `listing_source_metadata.metadata.priceQuality.status` for the generic,
 * source-agnostic `priceReliability` signal the Opportunity Engine consumes.
 * Never guesses a status: any missing, malformed, or unrecognized shape —
 * including every non-Facebook source's metadata, which never has this key —
 * resolves to `undefined`, which the engine already treats as fully trusted.
 */
export function parseFacebookPriceReliability(metadata: unknown): FacebookPriceStatus | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const priceQuality = (metadata as Record<string, unknown>).priceQuality;
  if (!priceQuality || typeof priceQuality !== "object" || Array.isArray(priceQuality)) return undefined;
  const status = (priceQuality as Record<string, unknown>).status;
  return typeof status === "string" && (FACEBOOK_PRICE_STATUSES as readonly string[]).includes(status) ? status as FacebookPriceStatus : undefined;
}
