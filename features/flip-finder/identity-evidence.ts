import type { ListingSource } from "./types";

export type ListingIdentityEvidence = {
  agencyReference: { agency: string; number: string } | null;
  buildingKey: string | null;
  apartmentNumber: string | null;
  unitKey: string | null;
  marketType: "primary" | "secondary" | null;
  buildingType: string | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  /** Same-origin media asset references after removing only known transform parameters. */
  sharedPhotoAssetKeys: string[];
};

export type ListingIdentityEvidenceInput = {
  source: ListingSource;
  title?: string | null;
  description?: string | null;
  address?: unknown;
  city?: string | null;
  district?: string | null;
  area?: number | null;
  rooms?: number | null;
  floor?: string | null;
  marketType?: unknown;
  buildingType?: string | null;
  images?: readonly string[] | null;
  sourceRecord?: unknown;
};

const EMPTY_EVIDENCE: ListingIdentityEvidence = {
  agencyReference: null,
  buildingKey: null,
  apartmentNumber: null,
  unitKey: null,
  marketType: null,
  buildingType: null,
  area: null,
  rooms: null,
  floor: null,
  sharedPhotoAssetKeys: [],
};

/** Extracts only explicit, parser-visible evidence. Portal IDs/SKUs and raw payload identity claims are deliberately ignored. */
export function extractListingIdentityEvidence(input: ListingIdentityEvidenceInput): ListingIdentityEvidence {
  if (input.source === "facebook") return { ...EMPTY_EVIDENCE };
  const record = isRecord(input.sourceRecord) ? input.sourceRecord : {};
  const offered = firstRecord(record.itemOffered, atPath(record, ["offers", "itemOffered"]), atPath(record, ["mainEntity", "itemOffered"])) ?? record;
  const address = firstRecord(input.address, offered.address, record.address, atPath(record, ["location", "address"]));
  const agency = extractAgencyReference(record);
  const parsedAddress = extractUnitAddress(address, record, offered, input.address, input.city);
  return {
    agencyReference: agency,
    buildingKey: parsedAddress?.buildingKey ?? null,
    apartmentNumber: parsedAddress?.apartmentNumber ?? null,
    unitKey: parsedAddress?.apartmentNumber ? `${parsedAddress.buildingKey}|unit:${parsedAddress.apartmentNumber}` : null,
    marketType: normalizeMarket(input.marketType ?? record.marketType ?? offered.marketType),
    buildingType: normalizeBuilding(input.buildingType ?? record.buildingType ?? offered.buildingType),
    area: finitePositive(input.area),
    rooms: finitePositive(input.rooms),
    floor: normalizeValue(input.floor ?? text(record, "floor", "floorLevel") ?? text(offered, "floor", "floorLevel")),
    sharedPhotoAssetKeys: [...new Set((input.images ?? []).map(normalizeSharedPhotoAssetKey).filter((key): key is string => key !== null))].slice(0, 10),
  };
}

/** Re-validates JSON returned by Postgres; invalid/partial evidence fails closed to empty evidence. */
export function normalizeListingIdentityEvidence(value: unknown): ListingIdentityEvidence {
  if (!isRecord(value)) return { ...EMPTY_EVIDENCE };
  const agency = isRecord(value.agencyReference) ? value.agencyReference : null;
  const agencyReference = agency
    ? normalizeAgencyReference(agency.agency, agency.number)
    : null;
  const buildingKey = normalizeValue(value.buildingKey);
  const apartmentNumber = normalizeApartmentNumber(value.apartmentNumber);
  const marketType = normalizeMarket(value.marketType);
  const photoKeys = Array.isArray(value.sharedPhotoAssetKeys)
    ? value.sharedPhotoAssetKeys.flatMap((item) => {
      if (typeof item !== "string") return [];
      const normalized = normalizeSharedPhotoAssetKey(item);
      return normalized ? [normalized] : [];
    })
    : [];
  return {
    agencyReference,
    buildingKey,
    apartmentNumber,
    unitKey: buildingKey && apartmentNumber ? `${buildingKey}|unit:${apartmentNumber}` : null,
    marketType,
    buildingType: normalizeBuilding(value.buildingType),
    area: finitePositive(value.area),
    rooms: finitePositive(value.rooms),
    floor: normalizeValue(value.floor),
    sharedPhotoAssetKeys: [...new Set(photoKeys)].slice(0, 10),
  };
}

export function hasListingIdentityEvidence(value: ListingIdentityEvidence): boolean {
  // Photos without a location or unit are not useful evidence by themselves
  // and should not force an optional DB write for every portal card.
  return Boolean(value.agencyReference || value.unitKey || value.buildingKey);
}

/** Keep previously parsed facts when a subsequent portal response omits them. */
export function mergeListingIdentityEvidence(previousValue: unknown, nextValue: ListingIdentityEvidence): ListingIdentityEvidence {
  const previous = normalizeListingIdentityEvidence(previousValue);
  const buildingKey = nextValue.buildingKey ?? previous.buildingKey;
  const apartmentNumber = nextValue.apartmentNumber ?? previous.apartmentNumber;
  return {
    agencyReference: nextValue.agencyReference ?? previous.agencyReference,
    buildingKey,
    apartmentNumber,
    unitKey: buildingKey && apartmentNumber ? `${buildingKey}|unit:${apartmentNumber}` : null,
    marketType: nextValue.marketType ?? previous.marketType,
    buildingType: nextValue.buildingType ?? previous.buildingType,
    area: nextValue.area ?? previous.area,
    rooms: nextValue.rooms ?? previous.rooms,
    floor: nextValue.floor ?? previous.floor,
    sharedPhotoAssetKeys: [...new Set([...previous.sharedPhotoAssetKeys, ...nextValue.sharedPhotoAssetKeys])].slice(0, 10),
  };
}

export type PairIdentityAssessment =
  | { kind: "confirmed"; reason: "same_agency_offer" | "same_exact_unit" }
  | { kind: "candidate"; reason: "same_building_photos_and_parameters" }
  | { kind: "separate"; reason: "explicit_conflict" | "insufficient_evidence" };

/**
 * High-confidence auto-linking uses a namespaced broker offer reference or
 * the exact apartment address plus compatible independent attributes.
 * Shared photos can only create a review candidate, never an automatic link.
 */
export function assessListingIdentityPair(
  left: ListingIdentityEvidence,
  right: ListingIdentityEvidence,
  options: { sameExplicitIdentity?: boolean; blocked?: boolean } = {},
): PairIdentityAssessment {
  if (options.blocked || hasHardConflict(left, right)) return { kind: "separate", reason: "explicit_conflict" };
  if (options.sameExplicitIdentity) return { kind: "confirmed", reason: "same_agency_offer" };
  if (left.agencyReference && right.agencyReference && sameAgencyReference(left.agencyReference, right.agencyReference)) {
    return { kind: "confirmed", reason: "same_agency_offer" };
  }
  if (left.unitKey && right.unitKey && left.unitKey === right.unitKey && hasCompatibleUnitDetails(left, right)) {
    return { kind: "confirmed", reason: "same_exact_unit" };
  }

  const sharedPhotos = left.sharedPhotoAssetKeys.filter((key) => right.sharedPhotoAssetKeys.includes(key));
  const sameBuilding = Boolean(left.buildingKey && right.buildingKey && left.buildingKey === right.buildingKey);
  if (sameBuilding && !left.unitKey && !right.unitKey && sharedPhotos.length >= 2 && hasCompatibleUnitDetails(left, right)) {
    return { kind: "candidate", reason: "same_building_photos_and_parameters" };
  }
  return { kind: "separate", reason: "insufficient_evidence" };
}

export function hasHardConflict(left: ListingIdentityEvidence, right: ListingIdentityEvidence): boolean {
  if (left.marketType && right.marketType && left.marketType !== right.marketType) return true;
  if (left.buildingType && right.buildingType && left.buildingType !== right.buildingType) return true;
  if (left.buildingKey && right.buildingKey && left.buildingKey !== right.buildingKey) return true;
  if (left.apartmentNumber && right.apartmentNumber && left.apartmentNumber !== right.apartmentNumber && left.buildingKey === right.buildingKey) return true;
  if (left.agencyReference && right.agencyReference
    && left.agencyReference.agency === right.agencyReference.agency
    && left.agencyReference.number !== right.agencyReference.number) return true;
  if (left.area !== null && right.area !== null && !areasCompatible(left.area, right.area)) return true;
  if (left.rooms !== null && right.rooms !== null && left.rooms !== right.rooms) return true;
  if (left.floor && right.floor && left.floor !== right.floor) return true;
  return false;
}

export function areasCompatible(left: number, right: number): boolean {
  const tolerance = Math.max(0.3, Math.min(0.8, Math.max(left, right) * 0.012));
  return Math.abs(left - right) <= tolerance;
}

/** Exact shared original media key; transformation-only query differences (size, format, watermark) are ignored. */
export function normalizeSharedPhotoAssetKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(w|width|h|height|resize|quality|q|format|auto|watermark|wm|fit|crop|dpr)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function extractAgencyReference(record: Record<string, unknown>): ListingIdentityEvidence["agencyReference"] {
  const agencyRecord = firstRecord(record.realEstateAgent, record.seller, record.provider, record.broker, record.agency, record.advertiser);
  // A free-standing `agencyName` or an unscoped numeric sku is not enough to
  // namespace a reference. Require an explicit seller/agent context parsed
  // from the source record and a labeled offer reference.
  if (!agencyRecord) return null;
  const agency = normalizeValue(agencyRecord.name ?? agencyRecord.legalName ?? agencyRecord.url);
  if (!agency) return null;
  const explicit = explicitReferenceFrom(record) ?? explicitReferenceFrom(agencyRecord);
  return explicit ? normalizeAgencyReference(agency, explicit) : null;
}

function explicitReferenceFrom(value: Record<string, unknown>): string | null {
  for (const key of ["agencyOfferNumber", "brokerOfferNumber", "agentReference", "agencyReferenceNumber"] as const) {
    const found = normalizeValue(value[key]);
    if (found) return found;
  }
  const properties = Array.isArray(value.additionalProperty) ? value.additionalProperty : [];
  for (const item of properties) {
    if (!isRecord(item)) continue;
    const label = normalizeValue(item.name ?? item.propertyID ?? item.identifier)?.toLowerCase() ?? "";
    if (!/(?:nr|numer|number|referencja|reference).*(?:oferty|ogloszenia|listing)|(?:oferta|ogloszenie|listing).*(?:nr|numer|number|id)/u.test(label)) continue;
    const reference = normalizeValue(item.value ?? item.valueReference ?? item.description);
    if (reference) return reference;
  }
  return null;
}

function normalizeAgencyReference(agencyValue: unknown, numberValue: unknown): ListingIdentityEvidence["agencyReference"] {
  const agency = normalizeValue(agencyValue);
  const offerNumber = normalizeValue(numberValue);
  if (!agency || !offerNumber) return null;
  return { agency: normalizeTextKey(agency), number: normalizeTextKey(offerNumber) };
}

function sameAgencyReference(left: NonNullable<ListingIdentityEvidence["agencyReference"]>, right: NonNullable<ListingIdentityEvidence["agencyReference"]>): boolean {
  return left.agency === right.agency && left.number === right.number;
}

function extractUnitAddress(
  addressValue: unknown,
  record: Record<string, unknown>,
  offered: Record<string, unknown>,
  fallbackAddress: unknown,
  cityValue: unknown,
): { buildingKey: string; apartmentNumber: string | null } | null {
  const address = isRecord(addressValue) ? addressValue : {};
  const streetText = normalizeValue(address.streetAddress ?? address.street ?? address.streetName ?? fallbackAddress);
  let street = normalizeValue(address.street ?? address.streetName);
  let buildingNumber = normalizeValue(address.buildingNumber ?? address.houseNumber ?? record.buildingNumber ?? offered.buildingNumber);
  let apartmentNumber = normalizeApartmentNumber(address.apartmentNumber ?? address.flatNumber ?? address.unitNumber ?? address.addressFlat ?? record.apartmentNumber ?? record.flatNumber ?? record.unitNumber ?? offered.apartmentNumber ?? offered.flatNumber ?? offered.unitNumber);
  if (streetText) {
    const parsed = parseStreetAddress(streetText);
    street ??= parsed?.street ?? null;
    buildingNumber ??= parsed?.buildingNumber ?? null;
    apartmentNumber ??= parsed?.apartmentNumber ?? null;
  }
  const city = normalizeValue(cityValue) ?? normalizeValue(isRecord(addressValue) ? address.addressLocality ?? address.addressRegion : null);
  const normalizedStreet = street ? normalizeTextKey(street) : null;
  const normalizedBuilding = buildingNumber ? normalizeTextKey(buildingNumber) : null;
  if (!normalizedStreet || !normalizedBuilding) return null;
  return {
    buildingKey: [city ? normalizeTextKey(city) : "", normalizedStreet, normalizedBuilding].filter(Boolean).join("|"),
    apartmentNumber,
  };
}

function parseStreetAddress(value: string): { street: string; buildingNumber: string; apartmentNumber: string | null } | null {
  const compact = value.replace(/\s+/gu, " ").trim();
  const match = /^(?:(?:ul(?:ica)?|al(?:eja)?|pl(?:ac)?)\.?\s+)?(.+?)\s+(\d+[a-z]?)(?:\s*(?:\/|lok(?:al)?\.?\s*)(\d+[a-z]?))?$/iu.exec(compact);
  if (!match) return null;
  return { street: match[1], buildingNumber: match[2], apartmentNumber: normalizeApartmentNumber(match[3]) };
}

function hasCompatibleUnitDetails(left: ListingIdentityEvidence, right: ListingIdentityEvidence): boolean {
  if (left.area === null || right.area === null || !areasCompatible(left.area, right.area)) return false;
  if (left.rooms === null || right.rooms === null || left.rooms !== right.rooms) return false;
  if (left.marketType !== right.marketType && (left.marketType !== null || right.marketType !== null)) return false;
  return true;
}

function normalizeMarket(value: unknown): ListingIdentityEvidence["marketType"] {
  if (typeof value !== "string") return null;
  const normalized = normalizeTextKey(value).replace(/-/gu, " ");
  if (["primary", "new", "pierwotny", "rynek pierwotny"].includes(normalized)) return "primary";
  if (["secondary", "resale", "wtorny", "wtórny", "rynek wtorny", "rynek wtórny"].includes(normalized)) return "secondary";
  return null;
}

function normalizeBuilding(value: unknown): string | null {
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  const key = normalizeTextKey(normalized);
  if (/kamienic|tenement|czynszow/u.test(key)) return "kamienica";
  if (/blok|wielorodzinn/u.test(key)) return "blok";
  if (/dom|jednorodzinn/u.test(key)) return "dom";
  if (/szereg|blizniak/u.test(key)) return "szeregowiec";
  if (/apartamentow/u.test(key)) return "apartamentowiec";
  return key;
}

function normalizeTextKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[łŁ]/gu, "l").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, "-");
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const textValue = String(value).replace(/\s+/gu, " ").trim();
  return textValue ? textValue : null;
}

function normalizeApartmentNumber(value: unknown): string | null {
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  const match = /^(?:lok(?:al)?\.?\s*)?(\d+[a-z]?)$/iu.exec(normalized);
  return match ? match[1].toLocaleLowerCase("pl-PL") : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) if (isRecord(value)) return value;
  return null;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

function text(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const found = normalizeValue(value[key]);
    if (found) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
