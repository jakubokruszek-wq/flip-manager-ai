import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacebookGroupDisplayName, UNKNOWN_GROUP_DISPLAY_NAME } from "./display-name.ts";

test("a verified, non-empty name is returned as-is", () => {
  assert.equal(resolveFacebookGroupDisplayName({ name: "Łódź Nieruchomości Flip", nameVerified: true }), "Łódź Nieruchomości Flip");
});

test("nameVerified=false always renders the unknown fallback, regardless of what name contains", () => {
  assert.equal(resolveFacebookGroupDisplayName({ name: "1424921570856189", nameVerified: false }), UNKNOWN_GROUP_DISPLAY_NAME);
  assert.equal(resolveFacebookGroupDisplayName({ name: "Nieznana grupa", nameVerified: false }), UNKNOWN_GROUP_DISPLAY_NAME);
});

test("an empty, whitespace-only, or missing name renders the unknown fallback even when nameVerified is omitted", () => {
  assert.equal(resolveFacebookGroupDisplayName({ name: "" }), UNKNOWN_GROUP_DISPLAY_NAME);
  assert.equal(resolveFacebookGroupDisplayName({ name: "   " }), UNKNOWN_GROUP_DISPLAY_NAME);
  assert.equal(resolveFacebookGroupDisplayName({ name: null }), UNKNOWN_GROUP_DISPLAY_NAME);
  assert.equal(resolveFacebookGroupDisplayName({ name: undefined }), UNKNOWN_GROUP_DISPLAY_NAME);
});

test("a real, non-empty name with nameVerified omitted (e.g. a listing's own captured group_name) is returned as-is", () => {
  assert.equal(resolveFacebookGroupDisplayName({ name: "Łódzka Giełda Nieruchomości" }), "Łódzka Giełda Nieruchomości");
});

// The bare numeric-ID and literal "Facebook" fallback strings the review
// found scattered across the codebase must never come from this resolver.
test("this resolver never returns a bare numeric string or the literal brand name 'Facebook' as a fallback", () => {
  assert.notEqual(resolveFacebookGroupDisplayName({ name: null }), "Facebook");
  assert.notEqual(resolveFacebookGroupDisplayName({ name: "" }), "1424921570856189");
});
