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

// Manual-override mission requirement: a name that reads as non-real-estate
// (POMINIETA_NIERNIERUCHOMOSCIOWA) or unreadable (WYMAGA_WERYFIKACJI) can
// still be manually ticked and imported after the operator confirms/edits
// its name -- only an already-registered group (JUZ_W_MANAGERZE) is excluded,
// since re-importing it makes no sense.
test("every row except JUZ_W_MANAGERZE is manually selectable for import", () => {
  assert.match(source, /IMPORTABLE_STATUSES = new Set<FacebookGroupImportPreviewItem\["status"\]>\(\["NOWA_NIERUCHOMOSCIOWA", "MOZLIWY_DUPLIKAT", "WYMAGA_WERYFIKACJI", "POMINIETA_NIERNIERUCHOMOSCIOWA"\]\)/);
});

// "Importuj wszystkie grupy nieruchomościowe" mission requirement: the bulk
// action must only ever pre-select/act on rows the classifier itself marked
// as real estate, never a POMINIETA/WYMAGA_WERYFIKACJI row -- that always
// requires the explicit manual tick above.
test("the bulk 'import all real estate groups' action is restricted to classifier-confirmed real-estate rows", () => {
  assert.match(source, /REAL_ESTATE_BULK_STATUSES = new Set<FacebookGroupImportPreviewItem\["status"\]>\(\["NOWA_NIERUCHOMOSCIOWA"\]\)/);
  assert.match(source, /Importuj wszystkie grupy nieruchomościowe/);
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

// Real production bug: "Otwórz Twoje grupy na Facebooku" was a plain <a>
// link -- it opened Facebook but never told the extension to do anything,
// so the Manager always showed "no active discovery session" regardless of
// what happened on Facebook. The button must now actually drive a session.
test("the discovery button sends a real message to the extension instead of only opening a link", () => {
  assert.doesNotMatch(source, /render=\{<a href="https:\/\/www\.facebook\.com\/groups\/joins\/"/, "the old plain-link button must be gone");
  assert.match(source, /window\.postMessage\(\{ type: "FLIP_GROUP_DISCOVERY_REQUEST" \}, window\.location\.origin\)/, "clicking the button must actually message the extension, not just navigate");
  assert.match(source, /onClick=\{onRunDiscovery\}/, "the button's onClick must trigger the real discovery flow, not just render a link");
});

test("the discovery flow exposes every mission-required state, driven by the extension's own ACK/progress/result messages", () => {
  for (const state of ["IDLE", "WAITING", "FACEBOOK_OPENED", "READING", "RECEIVED", "NO_SESSION", "ERROR"]) {
    assert.match(source, new RegExp(`"${state}"`), `flow state ${state} must exist`);
  }
  assert.match(source, /FLIP_GROUP_DISCOVERY_ACK/, "the extension must be able to confirm it received the command");
  assert.match(source, /FLIP_GROUP_DISCOVERY_PROGRESS/);
  assert.match(source, /FLIP_GROUP_DISCOVERY_RESULT/);
  assert.match(source, /stage === "OPENING_FACEBOOK"\) setFlowState\("FACEBOOK_OPENED"\)/);
  assert.match(source, /stage === "READING"\) setFlowState\("READING"\)/);
});

test("an unresponsive extension shows a specific 'no session' diagnostic, never a generic 'no groups found' message", () => {
  assert.match(source, /setFlowState\("NO_SESSION"\)/);
  assert.match(source, /Rozszerzenie Flip Collector nie odpowiedziało/, "a timed-out request must name the extension as the specific problem");
  assert.doesNotMatch(source.match(/const timeoutId = window\.setTimeout\([\s\S]*?\}, 8_000\);/)?.[0] ?? "", /Brak wykrytych grup/, "the timeout path must never reuse the generic empty-results copy");
});

test("the origin check on every posted message prevents another page from spoofing discovery events", () => {
  const listenerBody = source.match(/const listener = \(event: MessageEvent\) => \{[\s\S]*?\n    \};/)?.[0];
  assert.ok(listenerBody, "the message listener must exist");
  assert.match(listenerBody, /event\.origin !== window\.location\.origin/, "messages from a different origin must be ignored");
  assert.match(listenerBody, /event\.source !== window/, "messages not from this same window must be ignored");
});
