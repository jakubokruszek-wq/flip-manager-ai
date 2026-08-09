import type { SearchFilter } from "@/features/flip-finder";
import type { PropertyFields } from "@/features/properties/types/property";

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
  | "locationText"
  | "buildingType"
> & {
  sellerType?: PropertyFields["sellerType"];
  ownership?: PropertyFields["ownership"];
  marketType?: SearchFilter["marketType"] | null;
};

export type FilterDecision = {
  matches: boolean;
  reasons: string[];
  unknownFields: string[];
};

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

  const price = candidate.price;
  const area = candidate.area;
  const hasValidPrice = isPositiveFinite(price);
  const hasValidArea = isPositiveFinite(area);

  if (filter.priceMin !== null || filter.priceMax !== null || filter.maxPricePerSqm !== null) {
    if (candidate.price === null) {
      reject(true, "price_missing");
    } else if (!hasValidPrice) {
      reject(true, "price_invalid");
    }
  }

  if (filter.areaMin !== null || filter.areaMax !== null || filter.maxPricePerSqm !== null) {
    if (candidate.area === null) {
      reject(true, "area_missing");
    } else if (!hasValidArea) {
      reject(true, "area_invalid");
    }
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
      reject(true, candidate.rooms === null ? "rooms_missing" : "rooms_invalid");
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

  return {
    matches: reasons.size === 0,
    reasons: [...reasons],
    unknownFields: [...unknownFields],
  };
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
