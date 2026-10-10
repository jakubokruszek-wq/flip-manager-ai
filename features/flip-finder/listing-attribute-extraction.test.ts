import assert from "node:assert/strict";
import test from "node:test";
import { assessBuildingType, extractBuildingType, extractOwnership, resolveBuildingType } from "./listing-attribute-extraction.ts";

test("extractBuildingType: confirmed, unambiguous declarations are extracted", () => {
  assert.equal(extractBuildingType("Mieszkanie w bloku z windą", null), "blok");
  assert.equal(extractBuildingType(null, "Lokal w przedwojennej kamienicy, wysoki standard"), "kamienica");
  assert.equal(extractBuildingType("Apartament", "Nowoczesny apartamentowiec, parking podziemny"), "apartamentowiec");
  assert.equal(extractBuildingType("Dom jednorodzinny na sprzedaż", null), "dom");
  assert.equal(extractBuildingType("Segment w zabudowie szeregowej", "Dom szeregowy, ogród"), "dom");
});

test("extractBuildingType: no declaration at all stays unknown (null), never guessed", () => {
  assert.equal(extractBuildingType("Ładne mieszkanie, 3 pokoje", "Blisko centrum, do zamieszkania od zaraz"), null);
  assert.equal(extractBuildingType(null, null), null);
});

test("extractBuildingType: a negated declaration is never extracted", () => {
  assert.equal(extractBuildingType("Mieszkanie", "To nie jest blok, tylko wolnostojący dom"), "dom", "the negated 'blok' must be dropped, leaving only the real, unnegated 'dom' declaration");
  assert.equal(extractBuildingType("Mieszkanie", "To nie blok"), null, "a purely negated declaration with no other real one stays unknown");
});

// Regression: plain \w (even under /u) is ASCII-only and silently stops at
// the first Polish diacritic, so a naive \w*-based pattern would never
// finish matching "wolnostojący" and miss this declaration entirely.
test("extractBuildingType: a multi-word qualifier containing Polish diacritics (ą/ę/ś/etc.) is matched in full", () => {
  assert.equal(extractBuildingType(null, "Dom wolnostojący, duża działka"), "dom");
  assert.equal(extractBuildingType(null, "Przestronny dom jednorodzinny"), "dom");
});

test("extractBuildingType: a bare, unqualified 'dom' in an unrelated context never fabricates a building type", () => {
  assert.equal(extractBuildingType("Mieszkanie blisko domu kultury", "W drodze do domu, 5 minut od centrum"), null);
});

test("extractBuildingType: a genuine contradiction (two distinct real declarations) stays unknown", () => {
  assert.equal(extractBuildingType("Mieszkanie w bloku", "Pomyłka, to kamienica"), null, "two different confirmed building types in the same listing is a contradiction, not a guess");
});

test("tenement renovation, elevator and apartment renovation still identify the offered building as a tenement", () => {
  assert.equal(extractBuildingType("Kamienica po rewitalizacji z windą", null), "kamienica");
  assert.equal(extractBuildingType("Mieszkanie z windą", "Lokal po remoncie w kamienicy"), "kamienica");
  assert.equal(extractBuildingType("Mieszkanie w kamienicy", "Po generalnym remoncie, gotowe do zamieszkania"), "kamienica");
});

test("nearby-building and explicit negation mentions do not label the offered apartment as a tenement", () => {
  assert.equal(extractBuildingType("Mieszkanie w bloku", "Kamienica obok, widok na zabytkową elewację"), "blok");
  assert.equal(extractBuildingType("Mieszkanie w bloku", "W sąsiedztwie kamienicy, lokal znajduje się w bloku"), "blok");
  assert.equal(extractBuildingType("To nie jest kamienica", "Mieszkanie w bloku"), "blok");
  assert.equal(extractBuildingType("Bez kamienicy", "Mieszkanie w bloku"), "blok");
});

// Confirmed Production case (listing 001193d7-4889-4db5-aab0-dbbdf15bd4a6):
// Domiporta's own text names the unit's real building twice ("domu
// jednopiętrowym", "domu dwurodzinnym") yet the old patterns recognized
// neither -- "piętrowy" only matched bare, and "dwurodzinny" (a house split
// into exactly two family units, still a standalone house) was entirely
// absent from the qualifier list, leaving this listing's buildingType
// permanently unknown and stuck in manual review instead of being correctly
// excluded as "dom" from a blok/apartamentowiec-only filter.
test("extractBuildingType: a numeric-prefixed 'piętrowy' and 'dwurodzinny' both confirm a standalone house", () => {
  assert.equal(extractBuildingType(null, "Mieszkanie w domu jednopiętrowym, na parterze"), "dom");
  assert.equal(extractBuildingType(null, "Dom dwupiętrowy, duży ogród"), "dom");
  assert.equal(
    extractBuildingType(
      "Polecam 64 m² dom z ogródkiem, garażem i tarasem w Łodzi",
      "Mieszkanie w domu jednopiętrowym na pierwszy piętrze mieści się w domu dwurodzinnym - na parterze mieszka sąsiad, oddzielne wejścia.",
    ),
    "dom",
    "the real Production listing text must now resolve to a confirmed house, not stay unknown",
  );
});

test("extractBuildingType: 'wielorodzinny' is deliberately not a house qualifier -- it names apartment-building scale, not a house", () => {
  assert.equal(extractBuildingType(null, "Budynek wielorodzinny, nowe mieszkania"), null);
});

// Generalizing the neighbour/negation exclusion from kamienica-only to every
// building type (per the Production fix above) must not start rejecting a
// genuinely affirmative declaration just because an earlier, unrelated
// bullet point happens to contain a neighbourhood word. Real OLX listings
// store raw, unstripped HTML in their description ("<li>Blok z
// cegły</li><li>1 piętro</li>..."), so a '<'/'>' tag boundary must stop the
// clause scan exactly like a period would.
test("extractBuildingType: an HTML tag boundary stops the neighbour-mention clause scan, so an unrelated earlier bullet never discards this unit's own affirmative declaration", () => {
  assert.equal(
    extractBuildingType(
      "2 pokojowe mieszkanie w okazyjnej cenie Łódź",
      "<p>Bezpośrednio sprzedam mieszkanie w okolicy Parku Reymonta w Łodzi</p><ul><li>Blok z cegły</li><li>1 piętro</li></ul>",
    ),
    "blok",
    "the own-unit 'Blok z cegły' bullet must not be discarded as a neighbour mention leaking across a tag boundary from an earlier bullet",
  );
});

test("extractBuildingType: a building type is still correctly excluded as a genuine neighbour mention with no HTML involved", () => {
  assert.equal(
    extractBuildingType(
      "Mieszkanie na sprzedaż, 60 m² Bałuty, Polna",
      "Polecam Polną Residence, nową inwestycję deweloperską w Łodzi na Bałutach, w okolicy bloków o niskiej zabudowie.",
    ),
    null,
    "'w okolicy bloków' describes the surrounding area's other blocks, not this unit's own building",
  );
});

// A clause-scoped negation lookback (reaching past the shared, fixed
// NEGATION_WINDOW's 2-word limit) was tried for this real Production case
// and reverted: without a sentence delimiter between two genuinely separate
// statements, it cannot be told apart from one real negated clause (see
// isNonListingBuildingMention's own comment), and wrongly discarded a later,
// unrelated, affirmative "blok" together with an earlier negated one in an
// existing test. This remains a known, accepted limitation, not a silent
// regression: the shared NEGATION_WINDOW still catches negation within its
// own 2-word reach exactly as before.
test("extractBuildingType: a negation further than the shared 2-word window is a known, accepted limitation -- not silently claimed as fixed", () => {
  assert.equal(extractBuildingType(null, "Nie szukasz zwykłego mieszkania w bloku."), "blok");
});

test("structured/text building conflict is unknown but retains tenement evidence for fail-closed filters", () => {
  const assessment = assessBuildingType("blok", "Mieszkanie po remoncie", "Lokal znajduje się w kamienicy po rewitalizacji.");
  assert.deepEqual(assessment, { value: null, conflict: true, tenementEvidence: true });
  assert.equal(resolveBuildingType("blok", "Mieszkanie w bloku", "Kamienica obok"), "blok");
  assert.deepEqual(assessBuildingType(null, "Mieszkanie w bloku i kamienicy", ""), { value: null, conflict: true, tenementEvidence: true });
});

test("extractBuildingType: case-insensitive", () => {
  assert.equal(extractBuildingType("MIESZKANIE W BLOKU", null), "blok");
});

test("extractOwnership: confirmed, unambiguous declarations are extracted", () => {
  assert.equal(extractOwnership("Mieszkanie na sprzedaż", "Pełna własność, księga wieczysta"), "pełna własność");
  assert.equal(extractOwnership(null, "Spółdzielcze własnościowe prawo do lokalu"), "spółdzielcze");
  assert.equal(extractOwnership(null, "Mieszkanie spółdzielcze, niski czynsz"), "spółdzielcze");
  assert.equal(extractOwnership(null, "Sprzedaż udziału we współwłasności"), "udział");
});

test("extractOwnership: no declaration stays unknown", () => {
  assert.equal(extractOwnership("Ładne mieszkanie", "3 pokoje, 2 piętro"), null);
});

test("extractOwnership: a negated declaration is never extracted", () => {
  assert.equal(extractOwnership("Mieszkanie", "Uwaga: to nie jest spółdzielcze, pełna własność"), "pełna własność");
  assert.equal(extractOwnership("Mieszkanie", "Bez pełnej własności, tylko wynajem"), null);
});

test("extractOwnership: a genuine contradiction stays unknown", () => {
  assert.equal(extractOwnership("Mieszkanie", "Pełna własność lub spółdzielcze, do uzgodnienia"), null, "two different confirmed ownership types is a contradiction, not a guess");
});

test("unknown structured building types stay unknown while direct tenement evidence is preserved", () => {
  assert.deepEqual(assessBuildingType("unmapped source type", "Kamienica po remoncie", null), { value: null, conflict: true, tenementEvidence: true });
});
