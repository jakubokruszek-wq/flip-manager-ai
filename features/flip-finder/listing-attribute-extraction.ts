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
  // The stem changes under declension (apartamentowiec -> apartamentowcu,
  // apartamentowca, apartamentowcem), so a "apartamentowiec\p{L}*" prefix
  // missed "Mieszkanie w apartamentowcu" entirely.
  { canonical: "apartamentowiec", regex: /\bapartamentow(?:iec|ca|cu|cem|ce|ców|cach|cami)(?!\p{L})/giu },
  { canonical: "kamienica", regex: /\bkamienic\p{L}*/giu },
  { canonical: "dom", regex: /szeregow\p{L}*/giu },
  // A bare "dom" is deliberately excluded: it is one of the most common
  // words in Polish ("blisko domu", "dom seniora", "w drodze do domu") and
  // would fabricate a building type from a passing mention. Only a "dom"
  // (or "domek") directly qualified by a real house-type descriptor counts
  // as a genuine declaration, in either word order.
  // "piętrowy" also appears fused with a count prefix with no space
  // ("jednopiętrowy", "dwupiętrowy", "trzypiętrowy" -- a one/two/three-storey
  // house); "dwurodzinny" (a house split into exactly two family units) is
  // still architecturally a standalone house, unlike "wielorodzinny" (many
  // units), which is deliberately left out here -- that phrasing describes
  // an apartment-building scale, not a house.
  { canonical: "dom", regex: /\bdom(?:ek)?\p{L}*\s+(?:wolnostoj\p{L}*|jednorodzinn\p{L}*|dwurodzinn\p{L}*|bliźniacz\p{L}*|parterow\p{L}*|(?:jedno|dwu|trzy)?piętrow\p{L}*|letniskow\p{L}*)/giu },
  { canonical: "dom", regex: /\b(?:wolnostoj\p{L}*|jednorodzinn\p{L}*|dwurodzinn\p{L}*|bliźniacz\p{L}*)\s+dom(?:ek)?\p{L}*/giu },
  // Only real inflections of "blok": a bare prefix also matched unrelated
  // words such as "blokada" or "blokowanie" and fabricated a building type.
  { canonical: "blok", regex: /\bblok(?:u|iem|owi|i|ów|ach|ami)?(?!\p{L})/giu },
  // A high-rise block ("wieżowiec") and a large-panel building ("z wielkiej
  // płyty") are explicit statements about the building itself. Diacritic-free
  // spellings are common in Facebook posts.
  { canonical: "blok", regex: /\bwie[żz]ow(?:iec|ca|cu|cem|ce|ców|cow)(?!\p{L})/giu },
  { canonical: "blok", regex: /\bwielk(?:iej|a|ą)\s+p[łl]yt(?:y|a|ą|cie)(?!\p{L})/giu },
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
  // A line break keeps the title and the description separate clauses, so a
  // neighbour phrase at the start of the description ("Kamienica obok.") is
  // never read as continuing the title's own statement ("Mieszkanie w bloku").
  return `${title ?? ""}\n${description ?? ""}`;
}

export function extractBuildingType(title: string | null, description: string | null): string | null {
  return extractCanonical(scanText(title, description), BUILDING_TYPE_PATTERNS, isNonListingBuildingMention);
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
  return extractCanonical(scanText(title, description), [{ canonical: "kamienica", regex: /kamienic\p{L}*/giu }], isNonListingBuildingMention) === "kamienica";
}

/**
 * A mention of ANY building type -- not only a tenement -- can describe a
 * neighbour instead of the unit actually offered ("obok bloku", "w
 * sąsiedztwie kamienicy", "naprzeciwko domu jednorodzinnego"). This is the
 * general rule every BUILDING_TYPE_PATTERNS match is checked against, not a
 * kamienica-specific carve-out.
 */
function isNonListingBuildingMention(match: RegExpExecArray, text: string): boolean {
  // Some sources store description as raw, unstripped HTML (e.g. OLX's own
  // "<li>Blok z cegły</li><li>1 piętro</li>" bullet markup). A '>'/'<' tag
  // boundary must stop the clause scan exactly like real punctuation would --
  // otherwise an unrelated earlier bullet ("...w okolicy Parku Reymonta</p>")
  // leaks into this match's own "before" text across a tag boundary and a
  // genuinely affirmative, this-unit declaration gets wrongly discarded as a
  // neighbour mention.
  const clauseStart = Math.max(text.lastIndexOf(".", match.index), text.lastIndexOf("!", match.index), text.lastIndexOf("?", match.index), text.lastIndexOf(";", match.index), text.lastIndexOf(",", match.index), text.lastIndexOf("\n", match.index), text.lastIndexOf(">", match.index)) + 1;
  const clauseEndCandidates = [".", "!", "?", ";", ",", "\n", "<"].map((separator) => text.indexOf(separator, match.index + match[0].length)).filter((index) => index >= 0);
  const clauseEnd = clauseEndCandidates.length ? Math.min(...clauseEndCandidates) : text.length;
  const before = text.slice(clauseStart, match.index).trim();
  const after = text.slice(match.index + match[0].length, clauseEnd).trim();
  // Negation itself is NOT re-checked here: extractCanonical's own shared
  // NEGATION_WINDOW already applies to every pattern, including these. A
  // wider, clause-scoped negation lookback was tried and reverted -- when a
  // listing's free text has no punctuation at all between two distinct
  // statements ("To nie jest kamienica Mieszkanie w bloku"), nothing
  // distinguishes that from one real negated clause, and widening the
  // reach wrongly discarded a later, unrelated, genuinely affirmative
  // declaration together with the earlier negated one.
  return NEIGHBOUR_CONTEXT_BEFORE.test(before)
    || NEIGHBOUR_PREPOSITION_ADJACENT.test(before)
    || STREET_NAME_PREFIX.test(text.slice(Math.max(0, match.index - 12), match.index))
    // "Kamienica obok" describes a neighbour, but in "mieszkanie w bloku obok
    // kamienicy" the locative "w bloku" locates this unit; "obok" then refers
    // to the next word, not to the block.
    || (NEIGHBOUR_CONTEXT_AFTER.test(after) && !LOCATIVE_BEFORE.test(before))
    || isPluralTenementMention(match);
}

const NEIGHBOUR_CONTEXT_BEFORE = /(?:\bobok|\bnaprzeciw(?:ko)?|\bw\s+sąsiedztwie|\bw\s+okolicy|\bpoblisk\p{L}*|\bsąsiedn\p{L}*|\bwidok(?:iem)?\s+na)(?!\p{L})/iu;
/**
 * Spatial prepositions that are common in ordinary address text ("przy ul.
 * Piotrkowskiej", "między Piotrkowską a Kościuszki") only describe a
 * neighbour when they directly govern the building word (at most two
 * adjectives in between: "wśród zabytkowych kamienic", "przy starej
 * kamienicy"), never anywhere earlier in the clause.
 */
const NEIGHBOUR_PREPOSITION_ADJACENT = /(?:^|[^\p{L}])(?:wśród|pośród|między|wokół|dookoła|otoczon\p{L}*|otoczeni\p{L}*|w\s+otoczeniu|niedaleko|przy|za\s+rogiem|kilka\s+kroków\s+od|sąsiaduj\p{L}*\s+z)(?:\s+(?!(?:w|we)(?!\p{L}))\p{L}+){0,2}\s*$/iu;
/** A street/square name ("ul. Kamienica") is an address, never a building type. */
const STREET_NAME_PREFIX = /(?:^|[^\p{L}])(?:ul\.?|ulic[ayi]|al\.|alej[ai]|aleja|pl\.|plac[u]?|os\.|osiedl[eua])\s*$/iu;
const NEIGHBOUR_CONTEXT_AFTER = /^(?:\s*\b(?:obok|naprzeciw(?:ko)?|w\s+sąsiedztwie|w\s+okolicy|poblisk\p{L}*|sąsiedn\p{L}*|wokół|dookoła|w\s+pobliżu)(?!\p{L}))/iu;
const LOCATIVE_BEFORE = /(?:^|[^\p{L}])(?:w|we)(?:\s+\p{L}+){0,2}\s*$/iu;
const PLURAL_TENEMENT = /^kamienic(?:e|ami|ach)?$/iu;

/**
 * Plural tenement forms ("kamienice", "pełno kamienic", "między
 * kamienicami") describe the surrounding area, not the unit on offer. They
 * are therefore never affirmative evidence. The one plural phrasing that
 * does locate the unit ("w jednej z kamienic") stays affirmative.
 */
function isPluralTenementMention(match: RegExpExecArray): boolean {
  if (!PLURAL_TENEMENT.test(match[0]) || match[0].toLocaleLowerCase("pl-PL") === "kamienica") return false;
  const before = match.input.slice(Math.max(0, match.index - 24), match.index);
  return !/\bjedn(?:ej|ą|a)\s+ze?\s+$/iu.test(before);
}

/**
 * A tenement mention that is not affirmative evidence about this unit but is
 * also not clearly about a neighbour (plural forms describing the area). It
 * never rejects a listing; Finder uses it only to ask the operator to verify
 * a structured-only building type.
 */
export function hasAmbiguousTenementMention(title: string | null, description: string | null): boolean {
  const text = scanText(title, description);
  const regex = /\bkamienic\p{L}*/giu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (NEGATION_WINDOW.test(before)) continue;
    if (isPluralTenementMention(match)) {
      const clauseStart = Math.max(text.lastIndexOf(".", match.index), text.lastIndexOf(",", match.index), text.lastIndexOf("\n", match.index), text.lastIndexOf(">", match.index)) + 1;
      const clauseBefore = text.slice(clauseStart, match.index);
      if (!NEIGHBOUR_CONTEXT_BEFORE.test(clauseBefore.trim()) && !NEIGHBOUR_PREPOSITION_ADJACENT.test(clauseBefore)) return true;
    }
  }
  return false;
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

/** Canonical building type for an operator- or source-supplied label; null when not a recognized category. */
export function normalizeStructuredBuildingType(value: unknown): string | null {
  const explicit = structuredText(value);
  return explicit.present ? normalizeBuildingType(explicit.value) : null;
}

function normalizeBuildingType(value: string | null): string | null {
  if (!value) return null;
  const normalized = fold(value);
  if (["blok", "blok mieszkalny", "block", "block of flats"].includes(normalized)) return "blok";
  if (["kamienica", "kamieniczny", "tenement", "tenement house"].includes(normalized)) return "kamienica";
  if (["dom", "house", "detached house", "single family house", "dom jednorodzinny", "wolnostojacy dom", "dom wolnostojacy", "zabudowa szeregowa", "dom szeregowy", "wolnostojacy", "szeregowiec", "blizniak", "ribbon", "detached", "semi detached", "terraced"].includes(normalized)) return "dom";
  // Otodom's structured enum names an apartment building plainly "apartment".
  if (["apartamentowiec", "budynek apartamentowy", "apartment building", "apartment block", "apartment"].includes(normalized)) return "apartamentowiec";
  // Known, explicitly named building categories that are neither a block nor
  // an apartment building. They are confirmed types (so a blok/apartamentowiec
  // filter rejects them), never guessed from other attributes.
  if (["loft"].includes(normalized)) return "loft";
  if (["plomba", "infill"].includes(normalized)) return "plomba";
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
