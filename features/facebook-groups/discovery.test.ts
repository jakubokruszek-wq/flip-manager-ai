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

test("a brand new group with a real captured name is NOWA", () => {
  const result = classifyDiscoveredFacebookGroupCandidate(candidate(), [], PRODUCTION_SOURCES);
  assert.equal(result.status, "NOWA");
  assert.equal(result.identifier, "999888777");
  assert.equal(result.discoveredName, "Łódź Nieruchomości Flip");
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
  assert.equal(result.status, "POMINIETA");
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
  assert.deepEqual(preview.map((item) => item.status), ["NOWA", "JUZ_W_MANAGERZE", "WYMAGA_WERYFIKACJI"]);
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
