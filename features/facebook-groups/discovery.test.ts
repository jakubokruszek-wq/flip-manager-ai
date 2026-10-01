import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroupImportPreview,
  buildHistoricalFacebookSourceMapping,
  classifyDiscoveredFacebookGroupCandidate,
  UNKNOWN_GROUP_NAME,
} from "./discovery.ts";

const PRODUCTION_SOURCES = [
  { sourceId: "402796264871862", sourceUrl: "https://www.facebook.com/groups/402796264871862/", sourceType: "GROUP" as const },
  { sourceId: "lodzsprzedazzakupwynajem", sourceUrl: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/", sourceType: "GROUP" as const },
];

function candidate(overrides: Partial<{ url: string; name: string | null; discoveredAt: string; skipReason: string | null }> = {}) {
  return { url: "https://www.facebook.com/groups/999888777/", name: "Łódź Nieruchomości Flip", discoveredAt: "2026-09-23T00:00:00.000Z", ...overrides };
}

test("a brand new group with a real captured name is NOWA_NIERUCHOMOSCIOWA", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate(), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "NOWA_NIERUCHOMOSCIOWA");
  assert.equal(result.identifier, "999888777");
  assert.equal(result.discoveredName, "Łódź Nieruchomości Flip");
});

// Real-estate classification mission: not every group the user has ever
// joined is real estate. A brand new, non-duplicate, named candidate whose
// name does not read as real estate must be POMINIETA_NIERNIERUCHOMOSCIOWA,
// never silently treated as NOWA_NIERUCHOMOSCIOWA.
test("a brand new group with a real name that is NOT real-estate-related is POMINIETA_NIERNIERUCHOMOSCIOWA, not NOWA_NIERUCHOMOSCIOWA", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Miłośnicy kotów Łódź" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "POMINIETA_NIERNIERUCHOMOSCIOWA");
  assert.equal(result.discoveredName, "Miłośnicy kotów Łódź");
});

test("a bare city name or weak business/investment term alone is not sufficient for NOWA_NIERUCHOMOSCIOWA", () => {
  assert.equal(classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Łódź" }), [], PRODUCTION_SOURCES).status, "POMINIETA_NIERNIERUCHOMOSCIOWA");
  assert.equal(classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Biznes i inwestycje" }), [], PRODUCTION_SOURCES).status, "POMINIETA_NIERNIERUCHOMOSCIOWA");
});

test("a URL matching an existing watched group is JUZ_W_MANAGERZE", () => {
  const watched = [{ url: "https://www.facebook.com/groups/999888777/", name: "Already Watched" }];
  const result = classifyDiscoveredFacebookGroupCandidate(candidate(), watched, PRODUCTION_SOURCES);
  assert.equal(result.status, "JUZ_W_MANAGERZE");
  assert.match(result.reason, /Already Watched/);
});

test("a URL matching an approved production source (no watched-group row) is also JUZ_W_MANAGERZE", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ url: "https://www.facebook.com/groups/402796264871862/" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "JUZ_W_MANAGERZE");
  assert.match(result.reason, /zatwierdzonym źródłem produkcyjnym/);
});

test("an invalid/unverifiable URL is WYMAGA_WERYFIKACJI", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ url: "https://www.facebook.com/marketplace/item/123" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "WYMAGA_WERYFIKACJI");
  assert.equal(result.identifier, null);
});

// "No activation from a screenshot name alone": a candidate with no real
// captured name must never be treated as ready to import.
test("a candidate with no discovered name is WYMAGA_WERYFIKACJI, never NOWA", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: null }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "WYMAGA_WERYFIKACJI");
  assert.equal(result.discoveredName, null);
});

test("a candidate whose name collides with an existing watched group but at a different URL is MOZLIWY_DUPLIKAT", () => {
  const watched = [{ url: "https://www.facebook.com/groups/111222333/", name: "Łódź Nieruchomości Flip" }];
  const result = classifyDiscoveredFacebookGroupCandidate(candidate(), watched, PRODUCTION_SOURCES);
  assert.equal(result.status, "MOZLIWY_DUPLIKAT");
});

test("an extension-flagged skip reason is always POMINIETA, even for an otherwise-valid URL", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ skipReason: "Grupa ogólna, niezwiązana z nieruchomościami." }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "POMINIETA_NIERNIERUCHOMOSCIOWA");
  assert.equal(result.reason, "Grupa ogólna, niezwiązana z nieruchomościami.");
});

test("buildGroupImportPreview de-duplicates the same group reported twice in one batch", () => {
  const preview = buildGroupImportPreview([candidate(), candidate()], [], PRODUCTION_SOURCES);
  assert.equal(preview.length, 1);
});

test("buildGroupImportPreview classifies each distinct candidate independently", () => {
  const preview = buildGroupImportPreview(
    [candidate(), candidate({ url: "https://www.facebook.com/groups/402796264871862/" }), candidate({ url: "https://www.facebook.com/marketplace/item/1" })],
    [],
    PRODUCTION_SOURCES,
  );
  assert.equal(preview.length, 3);
  assert.deepEqual(preview.map((item) => item.status), ["NOWA_NIERUCHOMOSCIOWA", "JUZ_W_MANAGERZE", "WYMAGA_WERYFIKACJI"]);
});

// Łódź-gating mission: this Watcher only ever scans Łódź, so a real-estate
// group's own name must also name Łódź (itself, a district, or the
// "łódzki/łódzkie" family) to be NOWA_NIERUCHOMOSCIOWA (the only
// bulk-import-eligible status). A confidently different city is excluded
// outright; a real-estate name with no city at all is genuinely ambiguous
// and left for manual review -- never guessed either way.
test("a real-estate group for a different, named Polish city is POMINIETA, never bulk-import-eligible", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Nieruchomości Warszawa - sprzedaż mieszkań" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "POMINIETA_NIERNIERUCHOMOSCIOWA");
  assert.match(result.reason, /innym mieście niż Łódź/);
});

test("a real-estate group that names no city at all is WYMAGA_WERYFIKACJI, not silently imported or silently skipped", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Nieruchomości na sprzedaż" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "WYMAGA_WERYFIKACJI");
  assert.match(result.reason, /nie wspomina Łodzi/);
});

test("a real-estate group naming the 'łódzkie' adjective (the mission's own example) is NOWA_NIERUCHOMOSCIOWA, exactly like naming Łódź itself", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Nieruchomości Łódzkie - sprzedaż i wynajem" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "NOWA_NIERUCHOMOSCIOWA");
});

test("a real-estate group naming a Łódź district (not the bare city name) is NOWA_NIERUCHOMOSCIOWA", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate({ name: "Mieszkania Bałuty i Widzew" }), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "NOWA_NIERUCHOMOSCIOWA");
});

test("buildHistoricalFacebookSourceMapping shows a real captured name when a matching watched group exists", () => {
  const watched = [{ name: "Łódź Sprzedaż Zakup Wynajem", sourceId: "lodzsprzedazzakupwynajem" }];
  const mapping = buildHistoricalFacebookSourceMapping(watched, PRODUCTION_SOURCES);
  const entry = mapping.find((item) => item.sourceId === "lodzsprzedazzakupwynajem");
  assert.ok(entry);
  assert.equal(entry.name, "Łódź Sprzedaż Zakup Wynajem");
  assert.equal(entry.isNamed, true);
});

// "Do not guess historical group names": any production source with no
// matching watched-group row must show the literal Nieznana grupa fallback,
// never an invented name.
test("buildHistoricalFacebookSourceMapping falls back to 'Nieznana grupa' for a source with no captured name", () => {
  const mapping = buildHistoricalFacebookSourceMapping([], PRODUCTION_SOURCES);
  assert.equal(mapping.length, PRODUCTION_SOURCES.length);
  for (const entry of mapping) {
    assert.equal(entry.name, UNKNOWN_GROUP_NAME);
    assert.equal(entry.isNamed, false);
  }
});

test("buildHistoricalFacebookSourceMapping covers every production source exactly once, in order", () => {
  const mapping = buildHistoricalFacebookSourceMapping([], PRODUCTION_SOURCES);
  assert.deepEqual(mapping.map((item) => item.sourceId), PRODUCTION_SOURCES.map((item) => item.sourceId));
});
