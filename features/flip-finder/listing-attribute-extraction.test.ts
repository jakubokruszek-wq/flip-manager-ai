import assert from "node:assert/strict";
import test from "node:test";
import { extractBuildingType, extractOwnership } from "./listing-attribute-extraction.ts";

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
