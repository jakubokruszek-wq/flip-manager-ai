import {
  assessBuildingType,
  extractBuildingType,
  hasAmbiguousTenementMention,
  normalizeStructuredBuildingType,
} from "./listing-attribute-extraction.ts";

/**
 * Single building-type qualification rule shared by every source (portal
 * scans, OLX, official catalogs, Facebook Watcher imports) and by the Finder
 * read path. It works only from this listing's own structured field, its own
 * title/description, and an explicit operator confirmation. It never infers a
 * type from the street, construction year, floor, ceiling height or price.
 *
 * Outcomes:
 * - `confirmed`: the type is known and allowed by the filter (or the filter
 *   does not restrict building types).
 * - `rejected`: a confirmed disallowed type (kamienica, dom, loft, plomba...)
 *   or direct tenement evidence contradicting a stale structured label.
 * - `needs_verification`: unknown or unresolved/ambiguous evidence. Finder
 *   shows these only in the separate "Do weryfikacji budynku" queue.
 */
export type BuildingQualificationStatus = "not_required" | "confirmed" | "rejected" | "needs_verification";

export type BuildingQualificationReason =
  | "building_type_not_restricted"
  | "building_type_confirmed_structured"
  | "building_type_confirmed_text"
  | "building_type_confirmed_operator"
  | "building_type"
  | "building_type_conflict"
  | "building_type_unknown"
  | "building_type_conflict_unresolved"
  | "building_type_ambiguous_tenement_mention"
  | "building_type_cross_portal_conflict";

export type BuildingQualification = {
  status: BuildingQualificationStatus;
  /** Canonical type when one is established; null when unknown or contradictory. */
  type: string | null;
  reason: BuildingQualificationReason;
  source: "operator" | "structured" | "text" | null;
};

export type BuildingQualificationInput = {
  structuredValue: unknown;
  title: string | null;
  description: string | null;
  /** An operator's explicit confirmation. It wins over source data and prose. */
  operatorConfirmedType?: string | null;
};

export const OPERATOR_CONFIRMABLE_BUILDING_TYPES = ["blok", "apartamentowiec", "kamienica", "dom", "loft", "plomba"] as const;
export type OperatorConfirmableBuildingType = (typeof OPERATOR_CONFIRMABLE_BUILDING_TYPES)[number];

export function isOperatorConfirmableBuildingType(value: unknown): value is OperatorConfirmableBuildingType {
  return typeof value === "string" && (OPERATOR_CONFIRMABLE_BUILDING_TYPES as readonly string[]).includes(value);
}

export function qualifyBuildingType(input: BuildingQualificationInput, allowedTypes: readonly string[]): BuildingQualification {
  const allowed = new Set(allowedTypes.map((value) => value.trim().toLocaleLowerCase("pl-PL")).filter(Boolean));
  const operatorType = normalizeStructuredBuildingType(input.operatorConfirmedType ?? null);
  if (operatorType) {
    if (allowed.size === 0) return { status: "not_required", type: operatorType, reason: "building_type_not_restricted", source: "operator" };
    return allowed.has(operatorType)
      ? { status: "confirmed", type: operatorType, reason: "building_type_confirmed_operator", source: "operator" }
      : { status: "rejected", type: operatorType, reason: "building_type", source: "operator" };
  }

  const assessment = assessBuildingType(input.structuredValue, input.title, input.description);
  const structuredType = normalizeStructuredBuildingType(input.structuredValue);
  const textType = extractBuildingType(input.title, input.description);
  const source = assessment.value === null ? null : structuredType === assessment.value ? "structured" : "text";
  if (allowed.size === 0) {
    return { status: "not_required", type: assessment.value, reason: "building_type_not_restricted", source };
  }

  if (assessment.conflict && assessment.tenementEvidence && !allowed.has("kamienica")) {
    // A directly described tenement contradicting a stale structured label
    // must never reach MATCHED or REVIEW for a non-tenement filter.
    return { status: "rejected", type: null, reason: "building_type_conflict", source: null };
  }
  if (assessment.value !== null) {
    if (!allowed.has(assessment.value)) return { status: "rejected", type: assessment.value, reason: "building_type", source };
    // A plural, area-level tenement mention ("okolica pełna kamienic") is not
    // evidence about this unit, but when the type rests only on a structured
    // label (no affirmative statement in the listing's own text) the operator
    // confirms it instead of Finder trusting the label blindly.
    if (textType === null && hasAmbiguousTenementMention(input.title, input.description) && !allowed.has("kamienica")) {
      return { status: "needs_verification", type: assessment.value, reason: "building_type_ambiguous_tenement_mention", source };
    }
    return { status: "confirmed", type: assessment.value, reason: source === "structured" ? "building_type_confirmed_structured" : "building_type_confirmed_text", source };
  }

  if (assessment.conflict) {
    // Two allowed categories (e.g. structured "blok", text "apartamentowiec")
    // still prove an allowed building; any other contradiction is unresolved.
    const candidates = [structuredType, textType].filter((value): value is string => value !== null);
    if (candidates.length === 2 && candidates.every((value) => allowed.has(value)) && !assessment.tenementEvidence) {
      return { status: "confirmed", type: textType, reason: "building_type_confirmed_text", source: "text" };
    }
    return { status: "needs_verification", type: null, reason: "building_type_conflict_unresolved", source: null };
  }
  return { status: "needs_verification", type: null, reason: "building_type_unknown", source: null };
}

export function buildingQualificationLabel(qualification: Pick<BuildingQualification, "reason" | "type">): string {
  switch (qualification.reason) {
    case "building_type_confirmed_operator": return `Typ budynku potwierdzony przez operatora: ${qualification.type}`;
    case "building_type_confirmed_structured": return `Typ budynku z danych źródła: ${qualification.type}`;
    case "building_type_confirmed_text": return `Typ budynku z opisu oferty: ${qualification.type}`;
    case "building_type_not_restricted": return qualification.type ? `Typ budynku: ${qualification.type}` : "Typ budynku nieznany (filtr go nie wymaga)";
    case "building_type": return `Niedozwolony typ budynku: ${qualification.type ?? "nieznany"}`;
    case "building_type_conflict": return "Opis wskazuje kamienicę wbrew danym źródła";
    case "building_type_unknown": return "Brak potwierdzonego typu budynku";
    case "building_type_conflict_unresolved": return "Sprzeczne informacje o typie budynku";
    case "building_type_ambiguous_tenement_mention": return "Typ tylko z danych źródła, a opis wspomina kamienice w okolicy";
    case "building_type_cross_portal_conflict": return "Ta sama oferta na innym portalu ma niedozwolony typ budynku — potwierdź";
  }
}
