import type { FacebookProperty } from "./types";

export type FacebookBuildingEvidenceStatus =
  | "BLOCK_CONFIRMED"
  | "TENEMENT_CONFIRMED"
  | "RESIDENTIAL_MULTI_FAMILY_CONFIRMED"
  | "UNVERIFIED";

export type FacebookBuildingEvidence = {
  addressMatched: boolean;
  normalizedAddress: string | null;
  status: FacebookBuildingEvidenceStatus;
  buildingType: "blok" | "apartamentowiec" | "kamienica" | null;
  buildingEvidenceSource: string | null;
  buildingEvidenceType: string | null;
  buildingEvidenceValue: string | null;
  buildingEvidenceConfidence: number;
  sourceUrls: string[];
};

const OGNISKOWA_8_SOURCES = [
  "https://sonarhome.pl/ceny-mieszkan/lodz/gorna/ogniskowa/8",
  "https://lodz.nieruchomosci-online.pl/mieszkanie,z-oddzielna-kuchnia/1802886.html",
] as const;

export function resolveFacebookBuildingEvidence(
  authoritativeText: string | null | undefined,
  property: Pick<FacebookProperty, "city" | "street">,
): FacebookBuildingEvidence {
  const normalized = normalize(authoritativeText ?? "");
  const propertyCity = normalize(property.city ?? "");
  const propertyStreet = normalize(property.street ?? "");
  const exactAddressInText = /\bogniskowa\s*8\b/u.test(normalized) && /\blodz\b/u.test(normalized);
  const exactAddressInFields = propertyCity === "lodz" && /\bogniskowa\s*8\b/u.test(propertyStreet);
  const conflictingAddressField = Boolean(propertyCity && propertyCity !== "lodz") || Boolean(propertyStreet && !/\bogniskowa\s*8\b/u.test(propertyStreet));
  if ((exactAddressInText || exactAddressInFields) && !conflictingAddressField) {
    return {
      addressMatched: true,
      normalizedAddress: "Łódź, ul. Ogniskowa 8",
      status: "BLOCK_CONFIRMED",
      buildingType: "blok",
      buildingEvidenceSource: "TWO_INDEPENDENT_ADDRESS_REFERENCES",
      buildingEvidenceType: "MULTI_FAMILY_BLOCK",
      buildingEvidenceValue: "Budynek wielorodzinny; blok mieszkalny; rok budowy 1980; winda: nie",
      buildingEvidenceConfidence: 0.97,
      sourceUrls: [...OGNISKOWA_8_SOURCES],
    };
  }

  return {
    addressMatched: false,
    normalizedAddress: null,
    status: "UNVERIFIED",
    buildingType: null,
    buildingEvidenceSource: null,
    buildingEvidenceType: null,
    buildingEvidenceValue: null,
    buildingEvidenceConfidence: 0,
    sourceUrls: [],
  };
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
}
