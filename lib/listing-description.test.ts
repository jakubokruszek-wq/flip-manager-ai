import assert from "node:assert/strict";
import test from "node:test";

import { formatListingDescription } from "./listing-description";

test("preserves paragraphs", () => {
  assert.equal(formatListingDescription("<p>Pierwszy akapit</p><p>Drugi akapit</p>"), "Pierwszy akapit\n\nDrugi akapit");
});

test("converts line breaks and decodes HTML entities", () => {
  assert.equal(formatListingDescription("Pierwsza linia<br>Druga&nbsp;linia &amp; więcej"), "Pierwsza linia\nDruga linia & więcej");
});

test("removes formatting tags while keeping their text", () => {
  assert.equal(formatListingDescription("<strong>Ważne</strong>: mieszkanie"), "Ważne: mieszkanie");
});

test("formats unordered lists as bullets", () => {
  assert.equal(formatListingDescription("<ul><li>Balkon</li><li>Winda</li></ul>"), "• Balkon\n• Winda");
});

test("returns an empty string for an empty description", () => {
  assert.equal(formatListingDescription(null), "");
  assert.equal(formatListingDescription("   "), "");
});
