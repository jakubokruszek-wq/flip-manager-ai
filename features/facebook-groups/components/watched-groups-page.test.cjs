/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "watched-groups-page.tsx"), "utf8");

// HOLD-blocker requirement: required "Nazwa grupy", never "opcjonalnie".
test("the add-group form labels the name field as required, not optional", () => {
  assert.match(source, /label="Nazwa grupy"/);
  assert.doesNotMatch(source, /Nazwa — opcjonalnie/);
});

test("the add-group submit button is disabled until both URL and name are supplied", () => {
  assert.match(source, /disabled=\{busy \|\| !form\.url\.trim\(\) \|\| !form\.name\?\.trim\(\)\}/);
});

test("'Wykryj grupy nieruchomościowe' discovery action is present, with explicit-selection import, never automatic activation", () => {
  assert.match(source, /Wykryj grupy nieruchomościowe/);
  assert.match(source, /Importuj wybrane/);
  // The import button is disabled while nothing is checked -- nothing can be
  // imported just because it was discovered/previewed.
  assert.match(source, /disabled=\{busy \|\| selectedCount === 0\}/);
});

test("every mission-required import preview status label is rendered", () => {
  for (const status of ["NOWA", "JUZ_W_MANAGERZE", "MOZLIWY_DUPLIKAT", "WYMAGA_WERYFIKACJI", "POMINIETA"]) {
    assert.match(source, new RegExp(status));
  }
});

test("only NOWA and MOZLIWY_DUPLIKAT rows are ever selectable for import", () => {
  assert.match(source, /IMPORTABLE_STATUSES = new Set<FacebookGroupImportPreviewItem\["status"\]>\(\["NOWA", "MOZLIWY_DUPLIKAT"\]\)/);
});

test("a discovered candidate's name always comes from what the extension actually reported, never invented client-side", () => {
  assert.match(source, /discoveredName/);
  assert.doesNotMatch(source, /Facebook group \$\{/, "the numeric-ID synthetic name fallback must never reappear in the UI");
});

test("the historical mapping section is read-only (no edit/toggle/remove actions) and uses the 'Nieznana grupa' fallback text, never an invented name", () => {
  assert.match(source, /Historyczne źródła Watchera \(tylko do odczytu\)/);
  assert.match(source, /Nieznana grupa/);
});

test("the group card's identifier line remains secondary text, never the primary <h3> label", () => {
  const cardMatch = source.match(/function GroupCard[\s\S]*?groupIdentifier\(group\.url\)/);
  assert.ok(cardMatch, "GroupCard must still render the identifier somewhere");
  assert.match(source, /<h3 className="font-bold">\{resolveFacebookGroupDisplayName\(group\)\}<\/h3>/, "the primary label must use the shared verified-name resolver, never the bare identifier");
});

// HOLD-blocker: module/global "last discovery preview" storage removed;
// the discovery handoff must go through a URL fragment (never a query
// parameter) and a token-authorized POST, never an unauthenticated GET.
test("the discovery token is read from the URL fragment, never a query parameter, and cleared immediately after reading", () => {
  assert.match(source, /window\.location\.hash\.match\(\/\^#group-discovery=/);
  assert.match(source, /clearDiscoveryHash/);
  assert.doesNotMatch(source, /searchParams.*group-discovery|group-discovery.*searchParams/i, "the token must never be read from a query parameter");
});

test("the preview and import requests send the token in a POST body, never a GET or a query string", () => {
  assert.match(source, /\/api\/facebook-watcher\/groups\/discover\/preview.*method:\s*"POST"/s);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*token\s*\}\)/);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*token:\s*discoveryToken,\s*selections\s*\}\)/);
});

test("no unauthenticated GET-based 'last preview' fetch remains", () => {
  assert.doesNotMatch(source, /facebookGroupsFetch\("\/api\/facebook-watcher\/groups\/discover",\s*\{\s*cache:\s*"no-store"\s*\}\)/, "the old unauthenticated GET /discover call must be gone");
});
