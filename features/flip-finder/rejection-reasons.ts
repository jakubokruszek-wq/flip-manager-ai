import type { SearchFilter } from "@/features/flip-finder";

/**
 * Turns the internal reason codes evaluateListingAgainstFilter() produces
 * (features/flip-finder/filter-evaluation.ts) into a specific, human-
 * readable Polish sentence with the real numbers involved -- never the bare
 * code, and never a generic "odrzucona". Every message here answers exactly
 * one question: which concrete filter criterion did this offer fail, and by
 * how much.
 */
export type RejectionReasonContext = {
  price: number | null;
  area: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  floor: string | null;
  buildingType: string | null;
  ownership: string | null;
  city: string | null;
  district: string | null;
};

const currency = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });

function zl(value: number | null): string {
  return value === null ? "?" : `${currency.format(value)} zł`;
}

function m2(value: number | null): string {
  return value === null ? "?" : `${plain.format(value)} m²`;
}

/** A reason that genuinely failed a criterion (REJECTED-bucket reason codes). */
export function describeRejectionReason(reason: string, context: RejectionReasonContext, filter: SearchFilter): string {
  switch (reason) {
    case "max_price_per_sqm":
      return `Cena za m²: ${zl(context.pricePerSqm)} > limit ${zl(filter.maxPricePerSqm)}`;
    case "price_min":
      return `Cena: ${zl(context.price)} < minimum ${zl(filter.priceMin)}`;
    case "price_max":
      return `Cena: ${zl(context.price)} > maksimum ${zl(filter.priceMax)}`;
    case "price_invalid":
      return "Nieprawidłowa cena oferty";
    case "area_min":
      return `Powierzchnia: ${m2(context.area)} < minimum ${m2(filter.areaMin)}`;
    case "area_max":
      return `Powierzchnia: ${m2(context.area)} > maksimum ${m2(filter.areaMax)}`;
    case "area_invalid":
      return "Nieprawidłowa powierzchnia oferty";
    case "rooms":
      return `Liczba pokoi (${context.rooms ?? "?"}) poza zakresem filtra (${filter.rooms.join(", ")})`;
    case "rooms_invalid":
      return "Nieprawidłowa liczba pokoi";
    case "floor_min":
      return `Piętro (${context.floor ?? "?"}) poniżej minimum ${filter.floorMin}`;
    case "floor_max":
      return `Piętro (${context.floor ?? "?"}) powyżej maksimum ${filter.floorMax}`;
    case "ground_floor":
      return "Parter — wykluczony przez filtr";
    case "building_type":
      return `Typ budynku „${context.buildingType ?? "?"}” nie pasuje do filtra (${filter.buildingTypes.join("/")})`;
    case "ownership":
      return `Forma własności „${context.ownership ?? "?"}” nie pasuje do filtra (${filter.ownershipTypes.join("/")})`;
    case "district":
      return `Dzielnica „${context.district ?? "?"}” nie pasuje do filtra`;
    case "city":
      return `Poza miastem ${filter.city ?? "?"}`;
    case "private_only":
      return "Oferta nie jest prywatna — filtr wymaga ofert prywatnych";
    case "market_type":
      return "Rynek oferty nie pasuje do filtra";
    case "required_keywords":
      return "Brak wymaganych słów kluczowych w treści";
    case "excluded_keywords":
      return "Treść zawiera wykluczone słowo kluczowe";
    case "manual_rejected":
      return "Odrzucona ręcznie przez operatora";
    case "archived":
      return "Zarchiwizowana";
    case "source_not_in_filter":
      return "Źródło oferty nie jest objęte tym filtrem";
    case "category_page":
      return "To strona kategorii, nie pojedyncza oferta";
    case "listing_missing":
      return "Oferta nie istnieje już w bazie";
    default:
      return reason;
  }
}

/** A field the filter needs but the offer has no confirmed value for (REVIEW-bucket). */
export function describeMissingField(field: string): string {
  switch (field) {
    case "price":
      return "Brak potwierdzonej ceny";
    case "area":
      return "Brak potwierdzonej powierzchni";
    case "rooms":
      return "Brak potwierdzonej liczby pokoi";
    case "floor":
      return "Brak potwierdzonego piętra";
    case "topFloor":
      return "Brak informacji o ostatnim piętrze";
    case "buildingType":
      return "Brak potwierdzonego typu budynku";
    case "ownership":
      return "Brak potwierdzonej formy własności";
    case "district":
      return "Brak potwierdzonej dzielnicy";
    case "city":
      return "Brak potwierdzonego miasta";
    case "sellerType":
      return "Brak informacji o typie sprzedającego";
    case "marketType":
      return "Brak informacji o rynku (pierwotny/wtórny)";
    default:
      return `Brak danych: ${field}`;
  }
}

/**
 * Every specific reason for one offer, in display order: real rejections
 * first, then missing-data gaps. "review" (the bucket marker itself, not a
 * real reason) is dropped -- the missing-field messages already say why.
 */
export function describeAllReasons(
  matchReasons: string[],
  missingFields: string[],
  context: RejectionReasonContext,
  filter: SearchFilter,
): string[] {
  const realReasons = matchReasons.filter((reason) => reason !== "review" && !reason.startsWith("unknown_"));
  return [
    ...realReasons.map((reason) => describeRejectionReason(reason, context, filter)),
    ...missingFields.map((field) => describeMissingField(field)),
  ];
}
