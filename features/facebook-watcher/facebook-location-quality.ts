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
};

export function reconcileFacebookLocation(property: FacebookProperty, context: LocationContext): {
  property: FacebookProperty;
  provenance: FacebookLocationProvenance;
} {
  const explicitCity = explicitPolishCity(context.authoritativeText);
  const currentCity = clean(property.city);
  const conflict = Boolean(explicitCity && currentCity && normalizeCity(explicitCity) !== normalizeCity(currentCity));
  const groupCity = !explicitCity && !currentCity ? explicitPolishCity(context.groupName) : null;
  const city = explicitCity ?? currentCity ?? groupCity;
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
      citySource: explicitCity ? "AUTHORITATIVE_TEXT" : currentCity ? "VISION" : groupCity ? "GROUP_FALLBACK" : "UNKNOWN",
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
    return { address: input.address, district: input.district, city: explicitCity ?? input.city };
  }
  return { address: firstAddressPart(input.address), district: null, city: explicitCity };
}

export function explicitPolishCity(value: string | null | undefined): string | null {
  const normalized = normalizeCity(value);
  if (!normalized) return null;
  if (/\blodz(?:i)?\b/u.test(normalized)) return "Łódź";
  if (/\bwarszaw(?:a|ie|y)\b/u.test(normalized)) return "Warszawa";
  return null;
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

function clean(value: string | null): string | null {
  return value?.trim() || null;
}
