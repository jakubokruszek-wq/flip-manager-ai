const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "flip-finder-page.tsx"), "utf8");
const inlineResults = fs.readFileSync(path.join(__dirname, "inline-filter-results.tsx"), "utf8");

test("normal Flip Finder UI uses the queue scan result funnel", () => {
  assert.match(page, /WYNIK OSTATNIEGO SKANU/);
  assert.match(page, /Zebrane posty/);
  assert.match(page, /Zweryfikowane EXACT/);
  assert.match(page, /SELL_PROPERTY/);
  assert.match(page, /ODRZUCONE/);
  assert.match(page, /Nowe zapisane oferty/);
  assert.match(page, /Zaktualizowane/);
  assert.match(page, /Ten skan nie dodał nowych ofert\.|Nie zapisano ofert\./);
  assert.match(page, /Szczegóły diagnostyczne/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void validateCollector\(activeFilter\)\}/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void testDirectExternalChannel\(\)\}/);
  assert.doesNotMatch(page, /\{collectorValidation \? <CollectorValidationPanel/);
  assert.doesNotMatch(page, /\{externalPingResult \? <div/);
});

test("saved listings database is labeled independently from the latest scan", () => {
  assert.match(inlineResults, /BAZA OFERT/);
  assert.match(inlineResults, /Aktywne zapisane oferty:/);
  assert.doesNotMatch(inlineResults, /Znalezione oferty:/);
});

test("archive is opt-in and fetched separately from the main finder", () => {
  assert.match(inlineResults, /Pokaż archiwum/);
  assert.match(inlineResults, /view=archive/);
  assert.match(inlineResults, /archiveOpen \? \(data\?\.archivedResults/);
});
