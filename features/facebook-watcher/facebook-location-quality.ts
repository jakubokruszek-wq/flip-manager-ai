import type { FacebookFieldConfidence } from "../facebook-worker/types.ts";
import type { FacebookProperty } from "./types.ts";

export type FacebookLocationProvenance = {
  city: string | null;
  citySource: "AUTHORITATIVE_TEXT" | "VISION" | "GROUP_FALLBACK" | "UNKNOWN";
  conflict: boolean;
  conflictReason: "AUTHORITATIVE_CITY_CONFLICT" | null;
  districtCleared: boolean;
  neighborhoodCleared: boolean;
};

type LocationContext = {
  authoritativeText: string | null | undefined;
  groupName?: string | null;
  groupUrl?: string | null;
};

export function reconcileFacebookLocation(property: FacebookProperty, context: LocationContext): {
  property: FacebookProperty;
  provenance: FacebookLocationProvenance;
} {
  const explicitCity = explicitPolishCity(context.authoritativeText);
  const currentCity = clean(property.city);
  const groupCity = !explicitCity
    ? explicitPolishGroupCity(context.groupUrl) ?? (!currentCity ? explicitPolishCity(context.groupName) : null)
    : null;
  const trustedCity = explicitCity ?? groupCity;
  const conflict = Boolean(trustedCity && currentCity && normalizeCity(trustedCity) !== normalizeCity(currentCity));
  const city = trustedCity ?? currentCity;
  const propertyResult: FacebookProperty = {
    ...property,
    city,
    district: conflict ? null : property.district,
    neighborhood: conflict ? null : property.neighborhood,
    fieldConfidence: locationConfidence(property.fieldConfidence, explicitCity, groupCity, conflict),
  };
  return {
    property: propertyResult,
    provenance: {
      city,
      citySource: explicitCity ? "AUTHORITATIVE_TEXT" : groupCity ? "GROUP_FALLBACK" : currentCity ? "VISION" : "UNKNOWN",
      conflict,
      conflictReason: conflict ? "AUTHORITATIVE_CITY_CONFLICT" : null,
      districtCleared: conflict && Boolean(property.district),
      neighborhoodCleared: conflict && Boolean(property.neighborhood),
    },
  };
}

export function safeFacebookDisplayLocation(input: {
  source: string;
  title: string | null;
  description: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
}): { address: string | null; district: string | null; city: string | null } {
  if (input.source !== "facebook") return { address: input.address, district: input.district, city: input.city };
  const explicitCity = explicitPolishCity([input.title, input.description].filter(Boolean).join(" "));
  if (!explicitCity || !input.city || normalizeCity(explicitCity) === normalizeCity(input.city)) {
    const city = explicitCity ?? clean(input.city);
    const district = clean(input.district);
    return { address: safeStreet(input.address, district, city), district, city };
  }
  return { address: safeStreet(input.address, null, explicitCity), district: null, city: explicitCity };
}

/** Build a display location from trusted components without inventing a street. */
export function composeFacebookLocation(input: {
  street?: string | null;
  neighborhood?: string | null;
  district?: string | null;
  city?: string | null;
}): string | null {
  const city = clean(input.city);
  const district = clean(input.district);
  const neighborhood = clean(input.neighborhood);
  const street = safeStreet(input.street, district, city);
  const values = street
    ? [street, neighborhood, district, city]
    : [city, district, neighborhood];
  const present = values.filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const unique = present.filter((value) => {
    const key = normalizeCity(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length ? unique.join(", ") : null;
}

export function explicitPolishCity(value: string | null | undefined): string | null {
  const normalized = normalizeCity(value);
  if (!normalized) return null;
  if (/\blodz(?:i)?\b/u.test(normalized)) return "Łódź";
  if (/\bwarszaw(?:a|ie|y)\b/u.test(normalized)) return "Warszawa";
  return null;
}

function explicitPolishGroupCity(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeCity(value);
  return /(?:^|[^a-z])lodz(?:i)?(?:[^a-z]|$)/u.test(normalized) || /lodz(?:i)?/u.test(normalized)
    ? "Łódź"
    : null;
}

export function normalizeCity(value: string | null | undefined): string {
  return value?.replace(/[łŁ]/g, "l").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, " ").trim() ?? "";
}

function locationConfidence(existing: FacebookFieldConfidence | undefined, explicitCity: string | null, groupCity: string | null, conflict: boolean): FacebookFieldConfidence | undefined {
  if (!existing && !explicitCity && !groupCity) return undefined;
  return {
    ...existing,
    city: explicitCity ? 1 : groupCity ? 0.45 : existing?.city,
    district: conflict ? 0 : existing?.district,
    neighborhood: conflict ? 0 : existing?.neighborhood,
  };
}

function firstAddressPart(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function safeStreet(value: string | null | undefined, district: string | null, city: string | null): string | null {
  const first = firstAddressPart(clean(value));
  if (!first) return null;
  const key = normalizeCity(first);
  return key && (key === normalizeCity(city) || key === normalizeCity(district)) ? null : first;
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
