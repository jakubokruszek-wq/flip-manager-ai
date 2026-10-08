/**
 * Conservative, confirmed-only extraction of buildingType/ownership from a
 * listing's own free text (title + description), for source adapters that
 * have no structured field for either and would otherwise hardcode null.
 *
 * Canonical target values (filter-evaluation.ts's evaluateKnownChoice does
 * an exact, case-insensitive match against these -- see search-filter-form.tsx):
 *   buildingType: "blok" | "kamienica" | "dom" | "apartamentowiec"
 *   ownership: "pełna własność" | "spółdzielcze" | "udział"
 *
 * Every pattern requires an explicit, named declaration (e.g. "blok",
 * "pełna własność") -- never inferred from price, area, or any other
 * indirect signal. A negation immediately before a match ("nie jest to
 * spółdzielcze", "bez pełnej własności") invalidates that match. If more
 * than one distinct canonical value survives negation filtering (a genuine
 * contradiction, or simply two different things mentioned in passing), the
 * result is null -- "no data" and "contradictory data" are both unknown,
 * never a guess.
 *
 * Uses \p{L} (Unicode letter), not \w, throughout: plain \w is ASCII-only
 * even under the /u flag and silently stops at the first Polish diacritic
 * (ą/ć/ę/ł/ń/ó/ś/ź/ż), breaking multi-word matches like "wolnostojący dom".
 */

const NEGATION_WINDOW = /\b(?:nie|bez|brak)\b\s+(?:\p{L}+\s+){0,2}$/iu;

type Pattern = { canonical: string; regex: RegExp };

const BUILDING_TYPE_PATTERNS: Pattern[] = [
  { canonical: "apartamentowiec", regex: /apartamentowiec\p{L}*/giu },
  { canonical: "kamienica", regex: /kamienic\p{L}*/giu },
  { canonical: "dom", regex: /szeregow\p{L}*/giu },
  // A bare "dom" is deliberately excluded: it is one of the most common
  // words in Polish ("blisko domu", "dom seniora", "w drodze do domu") and
  // would fabricate a building type from a passing mention. Only a "dom"
  // (or "domek") directly qualified by a real house-type descriptor counts
  // as a genuine declaration, in either word order.
  { canonical: "dom", regex: /\bdom(?:ek)?\p{L}*\s+(?:wolnostoj\p{L}*|jednorodzinn\p{L}*|bliźniacz\p{L}*|parterow\p{L}*|piętrow\p{L}*|letniskow\p{L}*)/giu },
  { canonical: "dom", regex: /\b(?:wolnostoj\p{L}*|jednorodzinn\p{L}*|bliźniacz\p{L}*)\s+dom(?:ek)?\p{L}*/giu },
  { canonical: "blok", regex: /\bblok\p{L}*/giu },
];

const OWNERSHIP_PATTERNS: Pattern[] = [
  { canonical: "pełna własność", regex: /pełn\p{L}*\s+własnoś\p{L}*/giu },
  { canonical: "spółdzielcze", regex: /spółdzielcz\p{L}*\s+własnościow\p{L}*/giu },
  { canonical: "spółdzielcze", regex: /spółdzielcz\p{L}*/giu },
  { canonical: "udział", regex: /udział\p{L}*\s+(?:we\s+)?współwłasnośc\p{L}*/giu },
];

function extractCanonical(text: string, patterns: Pattern[], ignoreMatch?: (match: RegExpExecArray, text: string) => boolean): string | null {
  const found = new Set<string>();
  for (const { canonical, regex } of patterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      if (!NEGATION_WINDOW.test(before) && !ignoreMatch?.(match, text)) {
        found.add(canonical);
      }
      // A zero-length match would loop forever; every pattern here matches
      // at least one real character, so this is defensive only.
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Combines title + description into one scan surface, same source fields filter-evaluation.ts's own free-text checks already use. */
function scanText(title: string | null, description: string | null): string {
  return `${title ?? ""} ${description ?? ""}`;
}

export function extractBuildingType(title: string | null, description: string | null): string | null {
  return extractCanonical(scanText(title, description), BUILDING_TYPE_PATTERNS, isNonListingTenementMention);
}

export function extractOwnership(title: string | null, description: string | null): string | null {
  return extractCanonical(scanText(title, description), OWNERSHIP_PATTERNS);
}

/**
 * Normalizes an explicit value supplied by a source's structured field.
 * An unknown-but-present value intentionally stays null and does not fall
 * back to prose: the structured source signal has precedence, and inventing
 * a different value from a passing text mention would be less conservative.
 */
export function resolveBuildingType(
  structuredValue: unknown,
  title: string | null,
  description: string | null,
): string | null {
  return assessBuildingType(structuredValue, title, description).value;
}

export type BuildingTypeAssessment = { value: string | null; conflict: boolean; tenementEvidence: boolean };

/**
 * Compare the persisted/source structure with affirmative text from this
 * listing itself. A precise, unnegated tenement statement is never hidden by
 * a contradictory legacy `building_type=blok` value. Conflicting evidence is
 * reported as unknown (not guessed); Finder can fail closed when the active
 * filter explicitly excludes tenements. Mentions of a nearby/surrounding
 * tenement and negated statements do not count as evidence about this unit.
 */
export function assessBuildingType(
  structuredValue: unknown,
  title: string | null,
  description: string | null,
): BuildingTypeAssessment {
  const explicit = structuredText(structuredValue);
  const structuredType = explicit.present ? normalizeBuildingType(explicit.value) : null;
  const textType = extractBuildingType(title, description);
  const textTenement = hasAffirmativeTenementMention(title, description);
  const tenementEvidence = structuredType === "kamienica" || textTenement;
  const conflict = Boolean(structuredType && textType && structuredType !== textType)
    || Boolean(textTenement && !textType)
    || Boolean(explicit.present && textTenement && !structuredType)
    || Boolean(textTenement && (structuredType && structuredType !== "kamienica" || textType && textType !== "kamienica"));
  if (conflict) return { value: null, conflict: true, tenementEvidence };
  return { value: explicit.present ? structuredType : textType, conflict: false, tenementEvidence };
}

/** A tenement is confirmed only by its own structured field or an affirmative, listing-specific statement. */
export function hasAffirmativeTenementMention(title: string | null, description: string | null): boolean {
  return extractCanonical(scanText(title, description), [{ canonical: "kamienica", regex: /kamienic\p{L}*/giu }], isNonListingTenementMention) === "kamienica";
}

function isNonListingTenementMention(match: RegExpExecArray, text: string): boolean {
  if (!/^kamienic\p{L}*$/iu.test(match[0])) return false;
  const clauseStart = Math.max(text.lastIndexOf(".", match.index), text.lastIndexOf("!", match.index), text.lastIndexOf("?", match.index), text.lastIndexOf(";", match.index), text.lastIndexOf(",", match.index), text.lastIndexOf("\n", match.index)) + 1;
  const clauseEndCandidates = [".", "!", "?", ";", ",", "\n"].map((separator) => text.indexOf(separator, match.index + match[0].length)).filter((index) => index >= 0);
  const clauseEnd = clauseEndCandidates.length ? Math.min(...clauseEndCandidates) : text.length;
  const before = text.slice(clauseStart, match.index).trim();
  const after = text.slice(match.index + match[0].length, clauseEnd).trim();
  const negated = /(?:\bnie(?:\s+\p{L}+){0,4}|\bbez|\bbrak(?:u)?)\s*$/iu.test(before);
  const neighboring = /(?:\bobok|\bnaprzeciw(?:ko)?|\bw\s+sąsiedztwie|\bw\s+okolicy|\bpoblisk\p{L}*|\bsąsiedn\p{L}*|\bwidok(?:iem)?\s+na)\b/iu.test(before)
    || /^(?:\s*\b(?:obok|naprzeciw(?:ko)?|w\s+sąsiedztwie|w\s+okolicy|poblisk\p{L}*|sąsiedn\p{L}*)\b)/iu.test(after);
  return negated || neighboring;
}

export function resolveOwnership(
  structuredValue: unknown,
  title: string | null,
  description: string | null,
): string | null {
  const explicit = structuredText(structuredValue);
  return explicit.present ? normalizeOwnership(explicit.value) : extractOwnership(title, description);
}

function structuredText(value: unknown): { present: boolean; value: string | null } {
  if (typeof value === "string") return { present: Boolean(value.trim()), value: value.trim() || null };
  if (typeof value === "number" && Number.isFinite(value)) return { present: true, value: String(value) };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const key of ["value", "text", "label"]) {
      if (typeof row[key] === "string" && row[key].trim()) return { present: true, value: (row[key] as string).trim() };
    }
  }
  return { present: false, value: null };
}

function fold(value: string): string {
  return value.trim().toLocaleLowerCase("pl-PL").replace(/ł/gu, "l").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeBuildingType(value: string | null): string | null {
  if (!value) return null;
  const normalized = fold(value);
  if (["blok", "blok mieszkalny", "block", "block of flats"].includes(normalized)) return "blok";
  if (["kamienica", "kamieniczny", "tenement", "tenement house"].includes(normalized)) return "kamienica";
  if (["dom", "house", "detached house", "single family house", "dom jednorodzinny", "wolnostojacy dom", "dom wolnostojacy", "zabudowa szeregowa", "dom szeregowy"].includes(normalized)) return "dom";
  if (["apartamentowiec", "budynek apartamentowy", "apartment building", "apartment block"].includes(normalized)) return "apartamentowiec";
  return null;
}

function normalizeOwnership(value: string | null): string | null {
  if (!value) return null;
  const normalized = fold(value);
  if (["pelna wlasnosc", "odrebna wlasnosc", "full ownership", "freehold"].includes(normalized)) return "pełna własność";
  if (["spoldzielcze", "spoldzielcze wlasnosciowe", "spoldzielcze wlasnosciowe prawo do lokalu", "cooperative ownership"].includes(normalized)) return "spółdzielcze";
  if (["udzial", "udzial we wspolwlasnosci", "share in co ownership", "shared ownership"].includes(normalized)) return "udział";
  return null;
}
