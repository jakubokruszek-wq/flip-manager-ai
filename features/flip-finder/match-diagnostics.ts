import type { SearchFilter } from "@/features/flip-finder";
import type { FilterDecision } from "@/features/flip-finder/filter-evaluation";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";

type Condition = { passed: boolean; expected: string; actual: string | number | null };

export type MatchDiagnostic = {
  listingId: string;
  title: string | null;
  price: number | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  district: string | null;
  decision: { matches: boolean };
  matches: boolean;
  reasons: {
    price: Condition;
    pricePerSqm: Condition;
    area: Condition;
    rooms: Condition;
    district: Condition;
    source: Condition;
    buildingType: Condition;
    floor: Condition;
    market: Condition;
  };
};

export type MatchDiagnosticSummary = {
  rejectedByPrice: number;
  rejectedByPricePerSqm: number;
  rejectedByRooms: number;
  rejectedByDistrict: number;
  rejectedByArea: number;
  rejectedByBuildingType: number;
  matched: number;
};

export function createMatchDiagnostic(
  listingId: string,
  listing: SourceListing,
  filter: SearchFilter,
  decision: FilterDecision,
): MatchDiagnostic {
  const rejected = new Set(decision.reasons);
  const unknown = new Set(decision.unknownFields);
  const calculatedPricePerSqm = positive(listing.price) && positive(listing.area)
    ? listing.price / listing.area
    : null;

  return {
    listingId,
    title: listing.title,
    price: listing.price,
    pricePerSqm: calculatedPricePerSqm,
    area: listing.area,
    rooms: listing.rooms,
    district: listing.district,
    decision: { matches: decision.matches },
    matches: decision.matches,
    reasons: {
      price: condition(
        !unknown.has("price") && !hasAny(rejected, ["price_missing", "price_invalid", "price_min", "price_max"]),
        range(filter.priceMin, filter.priceMax),
        listing.price,
      ),
      pricePerSqm: condition(
        !rejected.has("max_price_per_sqm"),
        filter.maxPricePerSqm === null ? "any" : `<=${filter.maxPricePerSqm}`,
        calculatedPricePerSqm,
      ),
      area: condition(
        !unknown.has("area") && !hasAny(rejected, ["area_missing", "area_invalid", "area_min", "area_max"]),
        range(filter.areaMin, filter.areaMax),
        listing.area,
      ),
      rooms: condition(
        !unknown.has("rooms") && !hasAny(rejected, ["rooms", "rooms_missing", "rooms_invalid"]),
        filter.rooms.length ? JSON.stringify(filter.rooms) : "any",
        listing.rooms,
      ),
      district: condition(
        !unknown.has("district") && !rejected.has("district"),
        filter.districts.length ? JSON.stringify(filter.districts) : "any",
        listing.district,
      ),
      source: condition(
        filter.sources.includes(listing.source),
        JSON.stringify(filter.sources),
        listing.source,
      ),
      buildingType: condition(
        !rejected.has("building_type"),
        filter.buildingTypes.length ? JSON.stringify(filter.buildingTypes) : "any",
        listing.buildingType,
      ),
      floor: condition(
        !hasAny(rejected, ["floor_min", "floor_max", "ground_floor"]),
        floorExpectation(filter),
        listing.floor,
      ),
      market: condition(
        !rejected.has("market_type"),
        filter.marketType ?? "any",
        null,
      ),
    },
  };
}

export function emptyMatchDiagnosticSummary(): MatchDiagnosticSummary {
  return { rejectedByPrice: 0, rejectedByPricePerSqm: 0, rejectedByRooms: 0, rejectedByDistrict: 0, rejectedByArea: 0, rejectedByBuildingType: 0, matched: 0 };
}

export function addMatchDiagnostic(summary: MatchDiagnosticSummary, diagnostic: MatchDiagnostic): void {
  if (!diagnostic.reasons.price.passed) summary.rejectedByPrice += 1;
  if (!diagnostic.reasons.pricePerSqm.passed) summary.rejectedByPricePerSqm += 1;
  if (!diagnostic.reasons.rooms.passed) summary.rejectedByRooms += 1;
  if (!diagnostic.reasons.district.passed) summary.rejectedByDistrict += 1;
  if (!diagnostic.reasons.area.passed) summary.rejectedByArea += 1;
  if (!diagnostic.reasons.buildingType.passed) summary.rejectedByBuildingType += 1;
  if (diagnostic.matches) summary.matched += 1;
}

export function mergeMatchDiagnosticSummaries(summaries: MatchDiagnosticSummary[]): MatchDiagnosticSummary {
  return summaries.reduce((total, summary) => {
    for (const key of Object.keys(total) as Array<keyof MatchDiagnosticSummary>) total[key] += summary[key];
    return total;
  }, emptyMatchDiagnosticSummary());
}

function condition(passed: boolean, expected: string, actual: string | number | null): Condition {
  return { passed, expected, actual };
}

function range(min: number | null, max: number | null): string {
  if (min === null && max === null) return "any";
  if (min !== null && max !== null) return `${min}..${max}`;
  return min !== null ? `>=${min}` : `<=${max}`;
}

function floorExpectation(filter: SearchFilter): string {
  const values = [range(filter.floorMin, filter.floorMax)];
  if (filter.excludeGroundFloor) values.push("not ground floor");
  if (filter.excludeTopFloor) values.push("not top floor (unknown metadata accepted)");
  return values.join(", ");
}

function hasAny(values: Set<string>, expected: string[]): boolean {
  return expected.some((value) => values.has(value));
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}
