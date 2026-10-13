import type { SearchFilter } from "./index.ts";
import { dedupeByListingIdentity, type ListingIdentity } from "../listing-identity.ts";
import { groupPropertyResults, type PropertyIdentityGroupOptions } from "./property-identity.ts";
import { describeRejectionReason } from "./rejection-reasons.ts";
import type { FilterResult } from "./results.ts";

export type FinderSection = NonNullable<FilterResult["finderSection"]>;

/**
 * Exclusion reason codes for a CURRENT membership (is_current_match or an
 * explicit REVIEW membership) that does not appear in Dopasowane / Do oceny /
 * Do weryfikacji budynku. Each one is shown to the operator, so a persisted
 * match can never disappear without an explanation.
 */
export type FinderExclusionCode =
  | "listing_missing"
  | "listing_inactive"
  | "lifecycle_archived"
  | "lifecycle_stale"
  | "lifecycle_rejected"
  | "manual_rejected"
  | "source_conflict"
  | "invalid_price"
  | "filter_rejected"
  | "duplicate"
  | "linked_property_rejected";

export type FinderExcludedResult = {
  id: string;
  title: string | null;
  price: number | null;
  area: number | null;
  district: string | null;
  source: FilterResult["source"] | null;
  originalUrl: string | null;
  publishedAt: string | null;
  lastSeenAt: string | null;
  lifecycleStatus: FilterResult["lifecycleStatus"] | null;
  isCurrentMatch: boolean;
  code: FinderExclusionCode;
  reasons: string[];
  label: string;
};

export type FinderRow = FilterResult & {
  finderSection: FinderSection;
  exclusion?: { code: FinderExclusionCode; reasons: string[] } | null;
  isCurrentMatch?: boolean;
};

/** Exclusions that describe the property itself, so they also exclude its confirmed duplicates on other portals. */
const PROPERTY_LEVEL_FILTER_REASONS = new Set(["building_type", "building_type_conflict"]);

export function isPropertyLevelExclusion(exclusion: FinderRow["exclusion"]): boolean {
  if (!exclusion) return false;
  if (exclusion.code === "manual_rejected") return true;
  return exclusion.code === "filter_rejected" && exclusion.reasons.some((reason) => PROPERTY_LEVEL_FILTER_REASONS.has(reason));
}

export function exclusionLabel(code: FinderExclusionCode, reasons: readonly string[], row: Pick<FilterResult, "price" | "area" | "pricePerSqm" | "rooms" | "floor" | "buildingType" | "ownership" | "city" | "district"> | null, filter: SearchFilter): string {
  switch (code) {
    case "listing_missing": return "Oferta nie istnieje już w bazie ofert";
    case "listing_inactive": return "Ogłoszenie usunięte lub sprzedane";
    case "lifecycle_archived": return "Oferta zarchiwizowana";
    case "lifecycle_stale": return "Oferta oznaczona jako nieaktualna (STALE)";
    case "lifecycle_rejected": return "Status oferty: odrzucona (np. przez inny filtr lub wcześniejszą ocenę)";
    case "manual_rejected": return "Odrzucona ręcznie przez operatora";
    case "source_conflict": return "Adres ogłoszenia nie należy do deklarowanego źródła";
    case "invalid_price": return "Brak poprawnej całkowitej ceny sprzedaży";
    case "duplicate": return "Duplikat innej widocznej oferty (ten sam identyfikator lub adres ogłoszenia)";
    case "linked_property_rejected": return "Ta sama nieruchomość została odrzucona przez operatora (ręcznie lub jako niedozwolony typ budynku)";
    case "filter_rejected": {
      const context = {
        price: row?.price ?? null, area: row?.area ?? null, pricePerSqm: row?.pricePerSqm ?? null, rooms: row?.rooms ?? null,
        floor: row?.floor ?? null, buildingType: row?.buildingType ?? null, ownership: row?.ownership ?? null, city: row?.city ?? null, district: row?.district ?? null,
      };
      return reasons.length ? reasons.map((reason) => describeRejectionReason(reason, context, filter)).join("; ") : "Nie spełnia aktualnego filtra";
    }
  }
}

export function toExcludedResult(row: FinderRow, code: FinderExclusionCode, reasons: string[], filter: SearchFilter): FinderExcludedResult {
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    area: row.area,
    district: row.district,
    source: row.source,
    originalUrl: row.originalUrl,
    publishedAt: row.publishedAt ?? null,
    lastSeenAt: row.lastSeenAt,
    lifecycleStatus: row.lifecycleStatus ?? null,
    isCurrentMatch: row.isCurrentMatch ?? false,
    code,
    reasons,
    label: exclusionLabel(code, reasons, row, filter),
  };
}

const SECTION_PRIORITY: Record<FinderSection, number> = { MATCHED: 0, REVIEW: 1, BUILDING_VERIFICATION: 2, EXCLUDED: 3 };

export type FinderPartition = {
  matched: FilterResult[];
  review: FilterResult[];
  buildingVerification: FilterResult[];
  excluded: FinderExcludedResult[];
};

/**
 * Turns per-listing rows into the three visible Finder sections plus an
 * explicit exclusion list. Invariants (covered by finder-sections.test.ts):
 * - every input row appears exactly once: in one section (directly or as a
 *   linked member of a grouped card) or in `excluded` with a reason;
 * - deduplication prefers the row from the best section, so a MATCHED copy
 *   is never hidden behind a REVIEW/duplicate copy of the same ad;
 * - a confirmed cross-portal group is MATCHED when any member matches; an
 *   operator rejection of any copy excludes the whole property, while a
 *   disallowed building label on another portal sends the visible copies to
 *   building verification instead of hiding a correctly described block.
 */
export function partitionFinderRows(
  rows: readonly FinderRow[],
  options: {
    filter: SearchFilter;
    identityOf: (row: FinderRow) => ListingIdentity;
    qualityCompare?: (left: FinderRow, right: FinderRow) => number;
    grouping?: PropertyIdentityGroupOptions;
  },
): FinderPartition {
  const excluded: FinderExcludedResult[] = [];
  const excludedIds = new Set<string>();
  const exclude = (row: FinderRow, code: FinderExclusionCode, reasons: string[]) => {
    if (excludedIds.has(row.id)) return;
    excludedIds.add(row.id);
    excluded.push(toExcludedResult(row, code, reasons, options.filter));
  };

  const visibleCandidates: FinderRow[] = [];
  const propertyRejected: FinderRow[] = [];
  for (const row of rows) {
    if (row.finderSection === "EXCLUDED") {
      exclude(row, row.exclusion?.code ?? "filter_rejected", row.exclusion?.reasons ?? []);
      if (isPropertyLevelExclusion(row.exclusion)) propertyRejected.push(row);
    } else {
      visibleCandidates.push(row);
    }
  }

  const ordered = [...visibleCandidates].sort((left, right) =>
    SECTION_PRIORITY[left.finderSection] - SECTION_PRIORITY[right.finderSection]
    || (options.qualityCompare?.(left, right) ?? 0)
    || left.id.localeCompare(right.id));
  const kept = dedupeByListingIdentity(ordered, options.identityOf);
  const keptIds = new Set(kept.map((row) => row.id));
  for (const row of ordered) if (!keptIds.has(row.id)) exclude(row, "duplicate", []);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = groupPropertyResults([...kept, ...propertyRejected], options.grouping);
  const matched: FilterResult[] = [];
  const review: FilterResult[] = [];
  const buildingVerification: FilterResult[] = [];
  for (const group of groups) {
    const memberIds = (group.linkedListings ?? []).map((member) => member.id);
    const members = memberIds.map((id) => byId.get(id)).filter((row): row is FinderRow => Boolean(row));
    const place = (card: FinderRow, section: Exclude<FinderSection, "EXCLUDED">) => {
      const placed = { ...card, finderSection: section } as FinderRow;
      if (section === "MATCHED") matched.push(placed);
      else if (section === "REVIEW") review.push(placed);
      else buildingVerification.push(placed);
    };
    const rejectedMembers = members.filter((member) => member.finderSection === "EXCLUDED");
    const visibleMembers = members.filter((member) => member.finderSection !== "EXCLUDED");
    if (rejectedMembers.length === 0) {
      place(group as FinderRow, groupSection(members));
      continue;
    }
    if (visibleMembers.length === 0) continue; // already listed with their own reasons
    // An operator decision about the property (manual reject, or the operator
    // confirming a disallowed building type) applies to every portal copy.
    const operatorRejected = rejectedMembers.some((member) => member.exclusion?.code === "manual_rejected" || member.buildingQualification?.source === "operator");
    if (operatorRejected) {
      for (const member of visibleMembers) exclude(member, "linked_property_rejected", []);
      continue;
    }
    // Otherwise another portal's (possibly wrong) building label must not
    // hide a correctly described block: the operator confirms, and an
    // operator-confirmed allowed type settles it for the visible copies.
    const [visibleCard] = groupPropertyResults(visibleMembers, options.grouping) as FinderRow[];
    if (!visibleCard) continue;
    if (visibleMembers.some((member) => member.buildingQualification?.reason === "building_type_confirmed_operator")) {
      place(visibleCard, groupSection(visibleMembers));
      continue;
    }
    place({
      ...visibleCard,
      decisionBucket: "REVIEW",
      unknownFields: [...new Set([...(visibleCard.unknownFields ?? []), "buildingType"])],
      buildingQualification: { status: "needs_verification", type: null, reason: "building_type_cross_portal_conflict", source: null },
    }, "BUILDING_VERIFICATION");
  }
  return { matched, review, buildingVerification, excluded };
}

/** A group is MATCHED when any member matches; it needs building verification only when no member confirms the building. */
function groupSection(members: readonly FinderRow[]): Exclude<FinderSection, "EXCLUDED"> {
  if (members.some((member) => member.finderSection === "MATCHED")) return "MATCHED";
  const buildingConfirmed = members.some((member) => member.buildingQualification?.status === "confirmed" || member.buildingQualification?.status === "not_required");
  if (!buildingConfirmed && members.some((member) => member.finderSection === "BUILDING_VERIFICATION")) return "BUILDING_VERIFICATION";
  return "REVIEW";
}

/** Section for one listing's read-time decision (before deduplication and grouping). */
export function sectionForDecision(decisionBucket: "MATCHED" | "REVIEW" | "REJECTED", unknownFields: readonly string[]): FinderSection {
  if (decisionBucket === "MATCHED") return "MATCHED";
  if (decisionBucket === "REVIEW") return unknownFields.includes("buildingType") ? "BUILDING_VERIFICATION" : "REVIEW";
  return "EXCLUDED";
}
