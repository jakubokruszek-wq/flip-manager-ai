import type { LocationInput, LocationMatch, LocationResolution } from "./types.ts";

type StreetMapping = Pick<LocationResolution, "street" | "neighborhood" | "district" | "city">;

const STREET_MAPPINGS = new Map<string, StreetMapping>([
  ["lodz:rojna", { street: "Rojna", neighborhood: "Teofilów", district: "Bałuty", city: "Łódź" }],
]);

const EXPLICIT_NEIGHBORHOODS = [
  { pattern: /\bradogoszcz\s*[-–]?\s*zach(?:ód|od|\.)\b/iu, neighborhood: "Radogoszcz Zachód", district: "Bałuty", city: "Łódź" },
  { pattern: /\bradogoszcz\s*[-–]?\s*wsch(?:ód|od|\.)\b/iu, neighborhood: "Radogoszcz Wschód", district: "Bałuty", city: "Łódź" },
  { pattern: /\bteofil(?:ów|ow)\b/iu, neighborhood: "Teofilów", district: "Bałuty", city: "Łódź" },
  { pattern: /\bżubardź\b/iu, neighborhood: "Żubardź", district: "Bałuty", city: "Łódź" },
  { pattern: /\bradogoszcz\b/iu, neighborhood: "Radogoszcz", district: "Bałuty", city: "Łódź" },
] as const;

export function resolveDeterministicLocation(input: LocationInput): LocationResolution {
  const explicit = [explicitNeighborhood(input.title), explicitNeighborhood(input.description)]
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((left, right) => right.neighborhood.length - left.neighborhood.length)[0];
  const city = clean(input.city) ?? extractCity(input.locationText) ?? extractCity(input.address);
  const district = clean(input.district);
  const street = extractStreet(input.street, input.address, district, city);
  const mapping = city && street ? STREET_MAPPINGS.get(locationCacheKey(city, street) ?? "") : undefined;

  return {
    street: street ?? mapping?.street ?? null,
    neighborhood: explicit?.neighborhood ?? mapping?.neighborhood ?? null,
    district: district ?? explicit?.district ?? mapping?.district ?? null,
    city: city ?? explicit?.city ?? mapping?.city ?? null,
    confidence: explicit ? 0.99 : mapping ? 0.98 : street && city ? 0.7 : district && city ? 0.65 : city ? 0.5 : 0.2,
    evidence: explicit?.evidence ?? mapping?.street ?? "Pola lokalizacji oferty",
    source: "deterministic",
  };
}

function explicitNeighborhood(value: string | null) {
  if (!value) return null;
  const plainText = value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/giu, " ").normalize("NFC");
  for (const entry of EXPLICIT_NEIGHBORHOODS) {
    const match = plainText.match(entry.pattern);
    if (match?.[0]) return { ...entry, evidence: match[0].replace(/\s+/g, " ").trim() };
  }
  return null;
}

export function compareResolvedLocations(left: LocationResolution, right: LocationResolution): LocationMatch {
  return {
    streetMatch: equalKnown(left.street, right.street),
    neighborhoodMatch: neighborhoodsMatch(left.neighborhood, right.neighborhood),
    districtMatch: equalKnown(left.district, right.district),
    cityMatch: equalKnown(left.city, right.city),
  };
}

function neighborhoodsMatch(left: string | null, right: string | null): boolean {
  const leftKey = normalizeLocationPart(left);
  const rightKey = normalizeLocationPart(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  return (leftKey === "radogoszcz" && rightKey.startsWith("radogoszcz "))
    || (rightKey === "radogoszcz" && leftKey.startsWith("radogoszcz "));
}

export function locationCacheKey(city: string | null, street: string | null): string | null {
  const normalizedCity = normalizeLocationPart(city);
  const normalizedStreet = normalizeLocationPart(street);
  return normalizedCity && normalizedStreet ? `${normalizedCity}:${normalizedStreet}` : null;
}

export function normalizeLocationPart(value: string | null): string | null {
  return value
    ?.normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/giu, (letter) => letter === "Ł" ? "L" : "l")
    .toLocaleLowerCase("pl-PL")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ") || null;
}

function extractStreet(explicitStreet: string | null, address: string | null, district: string | null, city: string | null): string | null {
  if (clean(explicitStreet)) return stripStreetDecorations(explicitStreet as string);
  if (!address) return null;
  const excluded = new Set([normalizeLocationPart(district), normalizeLocationPart(city)].filter(Boolean));
  const parts = address.split(",").map(clean).filter((part): part is string => Boolean(part));
  const candidate = parts.find((part) => !excluded.has(normalizeLocationPart(part)));
  return candidate ? stripStreetDecorations(candidate) : null;
}

function stripStreetDecorations(value: string): string | null {
  return clean(value)
    ?.replace(/^(?:ulica|ul\.?|aleja|al\.?|plac|pl\.?)\s+/iu, "")
    .replace(/\s+\d+[\p{L}\d/-]*\s*$/u, "")
    .trim() || null;
}

function extractCity(value: string | null): string | null {
  if (!value) return null;
  return value.split(",").map(clean).find((part) => normalizeLocationPart(part) === "lodz") ?? null;
}

function equalKnown(left: string | null, right: string | null): boolean {
  const leftKey = normalizeLocationPart(left);
  const rightKey = normalizeLocationPart(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function clean(value: string | null): string | null {
  return value?.normalize("NFC").trim().replace(/\s+/g, " ") || null;
}
