/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const popupHtml = fs.readFileSync(path.join(__dirname, "popup.html"), "utf8");
const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
const groupDiscovery = fs.readFileSync(path.join(__dirname, "group-discovery.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

// Real production bug: the loaded popup only showed "Zbierz aktywne
// źródło" and "Konfiguracja" -- no way to manually trigger group discovery
// at all, even though the REPORT_DISCOVERED_GROUPS flow it depends on was
// already fully built and wired from group-discovery.js through
// background.js. This is the missing UI entry point.
test("the popup markup has a distinct 'Wykryj grupy nieruchomości' button, separate from 'Zbierz aktywne źródło'", () => {
  assert.match(popupHtml, /<button id="discover-groups">Wykryj grupy nieruchomości<\/button>/);
  assert.match(popupHtml, /<button id="active">Zbierz aktywne źródło<\/button>/);
});

test("the discover-groups button is wired to its own handler, not to run(\"COLLECT_ACTIVE_SOURCE\")", () => {
  assert.match(popup, /querySelector\("#discover-groups"\)\.addEventListener\("click", \(\) => void discoverGroups\(\)\)/);
  assert.match(popup, /querySelector\("#active"\)\.addEventListener\("click", \(\) => run\("COLLECT_ACTIVE_SOURCE"\)\)/);
});

test("discoverGroups asks the active tab's content script, not the background page directly, to run discovery", () => {
  assert.match(popup, /chrome\.tabs\.sendMessage\(tab\.id, \{ type: "RUN_GROUP_DISCOVERY" \}\)/);
  // Never conflated with the unrelated collector-scan message type.
  assert.doesNotMatch(popup.match(/async function discoverGroups[\s\S]*?\n\}/)?.[0] ?? "", /COLLECT_ACTIVE_SOURCE|COLLECT_CONFIGURED_SOURCES/);
});

test("discoverGroups requires the active tab to actually be Facebook's 'Twoje grupy' page before sending anything", () => {
  const body = popup.match(/async function discoverGroups[\s\S]*?\n\}/)?.[0];
  assert.ok(body, "discoverGroups function body must exist");
  assert.match(popup, /GROUPS_JOINS_PATTERN = \/\^https:\\\/\\\/\(\?:www\|m\)\\\.facebook\\\.com\\\/groups\\\/joins/);
  assert.match(body, /GROUPS_JOINS_PATTERN\.test\(tab\.url\)/);
  assert.match(body, /chrome\.tabs\.sendMessage/);
  // The guidance path (wrong tab) must return before any message is sent.
  const guardIndex = body.indexOf("GROUPS_JOINS_PATTERN.test(tab.url)");
  const sendIndex = body.indexOf("chrome.tabs.sendMessage");
  assert.ok(guardIndex >= 0 && sendIndex > guardIndex, "the URL check must happen before sendMessage is ever called");
});

test("the popup never imports/activates groups automatically -- it only asks for discovery, same as the mission requires", () => {
  const body = popup.match(/async function discoverGroups[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(body, /import|IMPORT_FACEBOOK_GROUP|groups\/import/i);
});

test("group-discovery.js exposes an on-demand listener for the same scan the popup button needs, distinct from its automatic window-load run", () => {
  assert.match(groupDiscovery, /message\?\.type !== "RUN_GROUP_DISCOVERY"/);
  assert.match(groupDiscovery, /window\.addEventListener\("load", \(\) => \{ void runGroupDiscovery\(\); \}\)/, "the pre-existing automatic run must remain, not be replaced");
});

test("the manifest still registers group-discovery.js only on Facebook's own 'Twoje grupy' page, on both desktop and mobile domains", () => {
  const groupsContentScript = manifest.content_scripts.find((entry) => entry.js.includes("group-discovery.js"));
  assert.ok(groupsContentScript, "group-discovery.js must be a registered content script");
  assert.deepEqual(new Set(groupsContentScript.matches), new Set(["https://www.facebook.com/groups/joins/*", "https://m.facebook.com/groups/joins/*"]));
});
