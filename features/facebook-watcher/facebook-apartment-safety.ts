import type { SearchFilter } from "@/features/flip-finder";
import type { FacebookProperty } from "./types";
import type { FacebookBuildingEvidence } from "./facebook-building-evidence";

export type FacebookApartmentSafetyDecision = {
  passes: boolean;
  reasons: string[];
  buildingType: string | null;
  locationVerified: boolean;
  buildingEvidence: FacebookBuildingEvidence;
};

const LODZ_CONTEXT = /\b(lodz|balut\w*|teofil\w*|widzew\w*|retkini\w*|polesi\w*|gorn\w*|srodmies\w*|radogoszcz\w*|zubardz\w*|chojn\w*|doly|dabrow\w*|rokici\w*|janow\w*)\b/u;
const OUTSIDE_LODZ = /\b(belchat\w*|pabianic\w*|zgierz\w*|sokolnik\w*|prusinowic\w*|szadk\w*|jezew\w*|dlutow\w*|aleksandr(?:ow|owa)\s+lodzki\w*|konstantynow\w*\s+lodzki\w*)\b/u;

export function evaluateFacebookApartmentSafety(input: {
  authoritativeText: string | null | undefined;
  property: Pick<FacebookProperty, "city">;
  filter: SearchFilter;
  buildingEvidence?: FacebookBuildingEvidence;
}): FacebookApartmentSafetyDecision {
  const text = normalize(input.authoritativeText ?? "");
  const reasons: string[] = [];
  const buildingEvidence = input.buildingEvidence ?? unverifiedBuildingEvidence();
  const buildingType = buildingEvidence.buildingType ?? inferBuildingType(text);

  if (/\bkamienic\w*\b/u.test(text)) reasons.push("FACEBOOK_BUILDING_KAMIENICA");
  if (/\b(blizniak\w*|dom(?:u|em|y|ow)?\s+(?:wolnostojac\w*|jednorodzinn\w*)|(?:sprzedam|na\s+sprzedaz)\s+dom\b)\b/u.test(text)) reasons.push("FACEBOOK_PROPERTY_HOUSE");
  if (/\b(dzialk\w*\s+(?:budowlan\w*|rekreacyjn\w*)|(?:sprzedam|na\s+sprzedaz)\s+dzialk\w*)\b/u.test(text)) reasons.push("FACEBOOK_PROPERTY_PLOT");

  if (buildingEvidence.status === "TENEMENT_CONFIRMED") reasons.push("FACEBOOK_BUILDING_KAMIENICA");
  else if (buildingEvidence.status === "UNVERIFIED" && buildingType === null) reasons.push("FACEBOOK_BUILDING_TYPE_UNVERIFIED");
  else if (input.filter.buildingTypes.length > 0 && !input.filter.buildingTypes.some((value) => normalize(value) === buildingType)) {
    reasons.push("FACEBOOK_BUILDING_TYPE_EXCLUDED");
  }

  const expectedCity = normalize(input.filter.city ?? "lodz");
  const extractedCity = normalize(input.property.city ?? "");
  const explicitOutside = OUTSIDE_LODZ.test(text) || Boolean(extractedCity && expectedCity && extractedCity !== expectedCity);
  const locationVerified = !explicitOutside && (LODZ_CONTEXT.test(text) || Boolean(extractedCity && extractedCity === expectedCity));
  if (explicitOutside) reasons.push("FACEBOOK_LOCATION_OUTSIDE_LODZ");
  else if (!locationVerified) reasons.push("FACEBOOK_LOCATION_UNVERIFIED");

  return { passes: reasons.length === 0, reasons: [...new Set(reasons)], buildingType, locationVerified, buildingEvidence };
}

function unverifiedBuildingEvidence(): FacebookBuildingEvidence {
  return { addressMatched: false, normalizedAddress: null, status: "UNVERIFIED", buildingType: null, buildingEvidenceSource: null, buildingEvidenceType: null, buildingEvidenceValue: null, buildingEvidenceConfidence: 0, sourceUrls: [] };
}

function inferBuildingType(text: string): string | null {
  if (/\bkamienic\w*\b/u.test(text)) return "kamienica";
  if (/\b(apartamentow\w*|nowoczesn\w+\s+(?:budyn\w*|inwestycj\w*)|now\w+\s+inwestycj\w*)\b/u.test(text)) return "apartamentowiec";
  if (/\b(blok\w*|wiezow\w*|wielk\w+\s+plyt\w*)\b/u.test(text)) return "blok";
  return null;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
}
