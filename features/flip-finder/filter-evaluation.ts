import type { SearchFilter } from "@/features/flip-finder";
import type { PropertyFields } from "@/features/properties/types/property";
import { LODZ_CONTEXT, OUTSIDE_LODZ_TOWN } from "@/features/location-intelligence/lodz-satellite-towns";
import { OTHER_POLISH_CITY } from "@/features/location-intelligence/other-polish-cities";
import { decisionBucket, type DecisionBucket } from "./decision-model.ts";
import { isKnownNonSaleListingIntent, MIN_TOTAL_SALE_PRICE_PLN, isSaleListingIntent } from "./sale-price-policy.ts";

export type FilterCandidate = Pick<
  PropertyFields,
  | "price"
  | "area"
  | "pricePerSqm"
  | "rooms"
  | "floor"
  | "city"
  | "district"
  | "title"
  | "description"
  | "locationText"
  | "buildingType"
> & {
  sellerType?: PropertyFields["sellerType"];
  ownership?: PropertyFields["ownership"];
  marketType?: SearchFilter["marketType"] | null;
  /** Source intent is present for Facebook; absent means a normal sale listing. */
  listingIntent?: string | null;
};

export type FilterDecision = {
  matches: boolean;
  bucket: DecisionBucket;
  reasons: string[];
  unknownFields: string[];
  missingFields: string[];
};

export type CanonicalListingDecision = {
  bucket: "MATCHED" | "REVIEW" | "REJECTED";
  reasons: string[];
  missingFields: string[];
  hardRejectReasons: string[];
};

/**
 * Single decision boundary shared by Finder reads and source reconciliation.
 * The underlying field checks remain in evaluateListingAgainstFilter; this
 * wrapper only exposes the canonical persisted-state contract.
 */
export function evaluateCanonicalListingDecision(
  candidate: FilterCandidate,
  filter: SearchFilter,
): CanonicalListingDecision {
  const decision = evaluateListingAgainstFilter(candidate, filter);
  return {
    bucket: decision.bucket,
    reasons: decision.reasons,
    missingFields: decision.missingFields,
    hardRejectReasons: decision.bucket === "REJECTED" ? decision.reasons : [],
  };
}

export function evaluateListingAgainstFilter(
  candidate: FilterCandidate,
  filter: SearchFilter,
): FilterDecision {
  const reasons = new Set<string>();
  const unknownFields = new Set<string>();
  const reject = (condition: boolean, reason: string) => {
    if (condition) {
      reasons.add(reason);
    }
  };
  const markUnknown = (field: string) => unknownFields.add(field);

  reject(isKnownNonSaleListingIntent(candidate.listingIntent), "non_sale_intent");

  const price = candidate.price;
  const area = candidate.area;
  const hasValidPrice = isPositiveFinite(price);
  const hasValidArea = isPositiveFinite(area);

  if (filter.priceMin !== null || filter.priceMax !== null || filter.maxPricePerSqm !== null) {
    if (candidate.price === null) {
      markUnknown("price");
    } else if (!hasValidPrice) {
      reject(true, "price_invalid");
    }
  }

  if (filter.areaMin !== null || filter.areaMax !== null || filter.maxPricePerSqm !== null) {
    if (candidate.area === null) {
      markUnknown("area");
    } else if (!hasValidArea) {
      reject(true, "area_invalid");
    }
  }

  if (price !== null && Number.isFinite(price)) {
    reject(isSaleListingIntent(candidate.listingIntent) && price < Math.max(MIN_TOTAL_SALE_PRICE_PLN, filter.priceMin ?? 0), "min_total_sale_price");
  }

  if (hasValidPrice) {
    reject(filter.priceMin !== null && price < filter.priceMin, "price_min");
    reject(filter.priceMax !== null && price > filter.priceMax, "price_max");
  }

  if (hasValidArea) {
    reject(filter.areaMin !== null && area < filter.areaMin, "area_min");
    reject(filter.areaMax !== null && area > filter.areaMax, "area_max");
  }

  if (filter.maxPricePerSqm !== null && hasValidPrice && hasValidArea) {
    reject(price / area > filter.maxPricePerSqm, "max_price_per_sqm");
  }

  if (filter.rooms.length > 0) {
    if (!isPositiveFinite(candidate.rooms)) {
      if (candidate.rooms === null) markUnknown("rooms");
      else reject(true, "rooms_invalid");
    } else {
      reject(!filter.rooms.includes(candidate.rooms), "rooms");
    }
  }

  const floor = parseFloor(candidate.floor);
  const floorIsRequired =
    filter.floorMin !== null || filter.floorMax !== null || filter.excludeGroundFloor;

  if (floorIsRequired && floor === null) {
    markUnknown("floor");
  }

  if (floor !== null) {
    reject(filter.floorMin !== null && floor < filter.floorMin, "floor_min");
    reject(filter.floorMax !== null && floor > filter.floorMax, "floor_max");
    reject(filter.excludeGroundFloor && floor === 0, "ground_floor");
  }

  if (filter.excludeTopFloor) {
    markUnknown("topFloor");
  }

  evaluateKnownChoice(
    candidate.buildingType,
    filter.buildingTypes,
    "buildingType",
    "building_type",
    markUnknown,
    reject,
  );
  evaluateKnownChoice(
    candidate.ownership ?? null,
    filter.ownershipTypes,
    "ownership",
    "ownership",
    markUnknown,
    reject,
  );
  evaluateKnownChoice(
    candidate.district,
    filter.districts,
    "district",
    "district",
    markUnknown,
    reject,
  );

  if (filter.city?.trim()) {
    const structuredCity = candidate.city?.trim() ? candidate.city : null;
    if (structuredCity === null) {
      // The structured city field is empty/unknown (a common geocoding gap
      // for imported listings, especially Facebook). Rather than silently
      // letting the listing through as REVIEW regardless of what town it
      // actually is, check whether the title/description/locationText names
      // a real, known Polish place that is not Łódź -- either a Łódź-
      // satellite town easily confused with Łódź itself (e.g. "Aleksandrów
      // Łódzki") or any other major Polish city (e.g. "Rzeszów", "Piotrków
      // Trybunalski") -- real production cases that both previously slipped
      // through a Łódź filter this way, reaching Finder as `unknown_city`
      // instead of a genuine city_mismatch. This only ever narrows an
      // otherwise unknown city to a confident exclusion; it never
      // manufactures a positive match from free text, and a name this
      // codebase does not recognize correctly stays unknown_city rather
      // than guessing -- "no location evidence" is the only case
      // unknown_city may still describe.
      const filterIsLodz = normalizeLocation(filter.city) === "lodz";
      const freeText = normalizeLocation(
        `${candidate.title ?? ""} ${candidate.description ?? ""} ${candidate.locationText ?? ""}`,
      );
      const namesAnotherRealPlace = (OUTSIDE_LODZ_TOWN.test(freeText) || OTHER_POLISH_CITY.test(freeText)) && !LODZ_CONTEXT.test(freeText);
      if (filterIsLodz && namesAnotherRealPlace) {
        reject(true, "city_mismatch");
      } else {
        markUnknown("city");
      }
    } else {
      // Some sources embed a district/neighborhood into the city field
      // itself (e.g. "Łódź-Bałuty", "Łódź-Widzew"). Treated as a match when
      // it names the filter's city as its own leading component, never as a
      // substring match anywhere (which could accept an unrelated place
      // that merely contains "Łódź" elsewhere in a longer compound value).
      const normalizedCandidate = normalizeLocation(structuredCity);
      const normalizedFilterCity = normalizeLocation(filter.city);
      const isSameCity = normalizedCandidate === normalizedFilterCity || normalizedCandidate.startsWith(`${normalizedFilterCity} `);
      reject(!isSameCity, "city_mismatch");
    }
  }

  if (filter.privateOnly) {
    if (candidate.sellerType === null || candidate.sellerType === undefined) {
      markUnknown("sellerType");
    } else {
      reject(candidate.sellerType !== "private", "private_only");
    }
  }

  if (filter.marketType !== null) {
    if (candidate.marketType === null || candidate.marketType === undefined) {
      markUnknown("marketType");
    } else {
      reject(candidate.marketType !== filter.marketType, "market_type");
    }
  }

  const text = `${candidate.title ?? ""} ${candidate.locationText ?? ""}`.toLocaleLowerCase(
    "pl-PL",
  );
  reject(
    !filter.requiredKeywords.every((word) => text.includes(word.toLocaleLowerCase("pl-PL"))),
    "required_keywords",
  );
  reject(
    filter.excludedKeywords.some((word) => text.includes(word.toLocaleLowerCase("pl-PL"))),
    "excluded_keywords",
  );

  const reasonList = [...reasons];
  const unknownList = [...unknownFields];
  const bucket = decisionBucket({ reasons: reasonList, unknownFields: unknownList });
  return { matches: bucket === "MATCHED", bucket, reasons: reasonList, unknownFields: unknownList, missingFields: unknownList };
}

export const evaluateFilter = evaluateListingAgainstFilter;

function evaluateKnownChoice(
  value: string | null,
  expectedValues: string[],
  unknownField: string,
  rejectionReason: string,
  markUnknown: (field: string) => void,
  reject: (condition: boolean, reason: string) => void,
): void {
  if (expectedValues.length === 0) {
    return;
  }

  if (value === null) {
    markUnknown(unknownField);
    return;
  }

  const normalizedValue = value.toLocaleLowerCase("pl-PL");
  reject(
    !expectedValues.some(
      (expectedValue) => expectedValue.toLocaleLowerCase("pl-PL") === normalizedValue,
    ),
    rejectionReason,
  );
}

function parseFloor(value: string | null): number | null {
  if (value === "parter") {
    return 0;
  }

  if (value === null || !value.trim()) {
    return null;
  }

  const floor = Number(value);
  return Number.isFinite(floor) ? floor : null;
}

function isPositiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function normalizeLocation(value: string): string {
  return value.replace(/[łŁ]/g, "l").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
