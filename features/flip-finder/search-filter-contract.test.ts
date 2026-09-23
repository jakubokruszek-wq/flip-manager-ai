import assert from "node:assert/strict";
import test from "node:test";
import { FACEBOOK_SOURCE_HELPER_TEXT, SEARCH_FILTER_SOURCE_OPTIONS } from "./search-filter-contract.ts";

// Flip Finder never runs its own Facebook scraper — Facebook listings only
// ever arrive already-collected and already-reconciled from the separate
// Facebook Watcher/Collector pipeline. The source picker's label must say so,
// so a user does not read this checkbox as "Finder will search Facebook",
// the same way the other three genuinely-live-fetched sources would suggest.
test("the Facebook source option is labeled as the Watcher's own already-collected offers, not a bare source name", () => {
  const facebookOption = SEARCH_FILTER_SOURCE_OPTIONS.find((option) => option.value === "facebook");
  assert.ok(facebookOption, "a facebook option must exist");
  assert.equal(facebookOption?.label, "Facebook Watcher — zebrane oferty");
});

// Finder/Watcher contract mission: enabling this source must never read as
// "Finder will scan Facebook" — the helper text next to the checkbox spells
// out the actual contract explicitly.
test("the Facebook helper text explains that Finder reads Watcher's collected offers and starts no new scan", () => {
  assert.equal(FACEBOOK_SOURCE_HELPER_TEXT, "Finder korzysta z ofert zebranych przez Watcher i nie uruchamia nowego skanowania Facebooka.");
});

test("the other sources keep their plain source-name labels — only Facebook needed the Watcher qualifier", () => {
  const labels = Object.fromEntries(SEARCH_FILTER_SOURCE_OPTIONS.map((option) => [option.value, option.label]));
  assert.equal(labels.otodom, "Otodom");
  assert.equal(labels.olx, "OLX");
  assert.equal(labels.morizon, "Morizon");
});
