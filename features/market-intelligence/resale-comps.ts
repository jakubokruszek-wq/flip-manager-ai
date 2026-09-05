import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";

export type RenovationConfidence = "HIGH" | "MEDIUM" | "LOW";
export type RenovationStatus = "RENOVATED" | "MOVE_IN_READY" | "REFRESHED" | "UNKNOWN";

export type ResaleCompClassification = {
  isCandidate: boolean;
  renovationStatus: RenovationStatus;
  renovationConfidence: RenovationConfidence;
  finishLevel: string | null;
  evidence: string[];
  outlierReason: string | null;
  exclusionReason: string | null;
};

export type ResaleCompInput = {
  source: SourceListing["source"];
  externalListingId: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  address: string | null;
  latitude?: number | null;
  longitude?: number | null;
  price: number | null;
  areaM2: number | null;
  pricePerM2: number | null;
  rooms: number | null;
  floor: string | null;
  floors?: string | null;
  buildingType: string | null;
  constructionYear?: number | null;
  ownership?: string | null;
  balcony?: boolean | null;
  elevator?: boolean | null;
  parking?: boolean | null;
  listingCreatedAt?: string | null;
  firstSeenAt?: string;
  lastSeenAt: string;
  active?: boolean;
  sellerType?: string | null;
  sourceListingId?: string | null;
};

export type ResaleCompRecord = ResaleCompInput & {
  id?: string;
  fingerprint: string | null;
  classification: ResaleCompClassification;
};

/**
 * Classifies only evidence present in the listing itself.  “Ładne” and
 * “odświeżone” never become HIGH confidence and missing evidence never turns
 * into an accepted comparable.
 */
export function classifyRenovation(input: Pick<ResaleCompInput, "title" | "description" | "price" | "areaM2" | "pricePerM2">): ResaleCompClassification {
  const text = normalize([input.title, input.description].filter(Boolean).join(" "));
  const evidence: string[] = [];
  const strongSignals: Array<[RegExp, string]> = [
    [/generaln\w*\s+remon/, "generalny remont"],
    [/kapitaln\w*\s+remon/, "kapitalny remont"],
    [/pel(?:n|ł)a modernizacj/, "pełna modernizacja"],
    [/now(?:e|y|a) instalacj/, "nowe instalacje"],
    [/wymienion(?:e|o|a) instalacj/, "wymienione instalacje"],
    [/wykonczon(?:e|y|a) pod klucz/, "wykończone pod klucz"],
    [/standard inwestycyjn/, "standard inwestycyjny"],
  ];
  const mediumSignals: Array<[RegExp, string]> = [
    [/po remoncie/, "po remoncie"],
    [/gotow(?:e|y|a) do zamieszkania/, "gotowe do zamieszkania"],
    [/now(?:a|e|y) kuchni/, "nowa kuchnia"],
    [/now(?:a|e|y) lazienk/, "nowa łazienka"],
    [/now(?:e|y|a) podlog/, "nowe podłogi"],
    [/premium|podwyzszon(?:y|ego) standard/, "podwyższony standard"],
  ];
  const weakSignals: Array<[RegExp, string]> = [
    [/odswiezon/, "odświeżone"],
    [/zadbane/, "zadbane"],
    [/ladne|ładne/, "ładne"],
  ];

  for (const [pattern, label] of strongSignals) if (pattern.test(text)) evidence.push(label);
  for (const [pattern, label] of mediumSignals) if (pattern.test(text)) evidence.push(label);
  for (const [pattern, label] of weakSignals) if (pattern.test(text)) evidence.push(label);

  const exclusionReason = hardExclusion(text);
  const outlierReason = detectOutlier(input.price, input.areaM2, input.pricePerM2);
  const hasStrong = evidence.some((item) => strongSignals.some(([, label]) => label === item));
  const mediumCount = evidence.filter((item) => mediumSignals.some(([, label]) => label === item)).length;
  const hasWeak = evidence.some((item) => weakSignals.some(([, label]) => label === item));
  const isCandidate = evidence.length > 0 && !exclusionReason;

  let renovationConfidence: RenovationConfidence = "LOW";
  if (hasStrong || mediumCount >= 2) renovationConfidence = "HIGH";
  else if (mediumCount > 0) renovationConfidence = "MEDIUM";
  const renovationStatus: RenovationStatus = hasStrong && /pod klucz|gotow/.test(text)
    ? "MOVE_IN_READY"
    : hasStrong || mediumCount > 0
      ? "RENOVATED"
      : hasWeak
        ? "REFRESHED"
        : "UNKNOWN";

  return {
    isCandidate,
    renovationStatus,
    renovationConfidence,
    finishLevel: hasStrong ? "GENERAL_RENOVATION" : mediumCount > 0 ? "MOVE_IN_READY" : hasWeak ? "REFRESHED" : null,
    evidence: [...new Set(evidence)],
    outlierReason,
    exclusionReason,
  };
}

export function toResaleCompRecord(listing: SourceListing, now = new Date().toISOString()): ResaleCompRecord {
  const classification = classifyRenovation({ title: listing.title, description: listing.description, price: listing.price, areaM2: listing.area, pricePerM2: listing.pricePerSqm });
  const address = listing.locationText;
  return {
    source: listing.source,
    externalListingId: listing.externalListingId,
    canonicalUrl: listing.originalUrl || listing.normalizedUrl || null,
    title: listing.title,
    description: listing.description,
    city: listing.city,
    district: listing.district,
    street: address,
    address,
    price: listing.price,
    areaM2: listing.area,
    pricePerM2: listing.pricePerSqm,
    rooms: listing.rooms,
    floor: listing.floor,
    buildingType: listing.buildingType,
    listingCreatedAt: listing.publishedAt ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    active: true,
    fingerprint: resaleCompFingerprint({ address, areaM2: listing.area, price: listing.price, rooms: listing.rooms }),
    classification,
  };
}

export function resaleCompFingerprint(input: { address: string | null; areaM2: number | null; price: number | null; rooms: number | null }): string | null {
  if (!input.address || input.areaM2 === null || input.price === null || input.rooms === null) return null;
  return [normalize(input.address), round(input.areaM2), round(input.price), round(input.rooms)].join("|");
}

export function freshnessWeight(lastSeenAt: string, now = Date.now()): number {
  const ageDays = Math.max(0, (now - Date.parse(lastSeenAt)) / 86_400_000);
  if (!Number.isFinite(ageDays) || ageDays > 90) return 0.1;
  if (ageDays <= 30) return 1;
  if (ageDays <= 60) return 0.7;
  return 0.4;
}

export function priceObservationChanged(previous: { price?: number | null; pricePerM2?: number | null } | null, price: number | null, pricePerM2: number | null): boolean {
  if (!previous) return true;
  return previous.price !== price || previous.pricePerM2 !== pricePerM2;
}

function hardExclusion(text: string): string | null {
  if (/wynajem|do wynajecia|najem|miesiecznie|czynsz najmu/.test(text)) return "RENT";
  if (/\bdom\b|szeregowiec|blizniak/.test(text)) return "HOUSE";
  if (/lokal uslug|lokal uzytkow|biuro|magazyn/.test(text)) return "COMMERCIAL";
  return null;
}

function detectOutlier(price: number | null, area: number | null, storedPricePerM2: number | null): string | null {
  const value = storedPricePerM2 ?? (price !== null && area !== null && area > 0 ? price / area : null);
  if (value === null || !Number.isFinite(value)) return "PRICE_PER_M2_MISSING";
  if (value < 2_000 || value > 30_000) return "PRICE_PER_M2_OUTLIER";
  return null;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
