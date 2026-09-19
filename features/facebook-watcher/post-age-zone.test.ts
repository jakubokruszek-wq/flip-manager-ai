import assert from "node:assert/strict";
import test from "node:test";

import { classifyFacebookPostAgeZone, isEligibleForCurrentProcessing } from "./post-age-zone.ts";

const now = Date.parse("2026-09-19T00:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

test("A. a 71h post is FRESH and eligible for normal processing", () => {
  assert.equal(classifyFacebookPostAgeZone(hoursAgo(71), now), "FRESH");
  assert.equal(isEligibleForCurrentProcessing(classifyFacebookPostAgeZone(hoursAgo(71), now)), true);
});

test("B. a 73h post is OLD and ineligible for heavy/current processing", () => {
  assert.equal(classifyFacebookPostAgeZone(hoursAgo(73), now), "OLD");
  assert.equal(isEligibleForCurrentProcessing(classifyFacebookPostAgeZone(hoursAgo(73), now)), false);
});

test("exactly 72h is still FRESH (inclusive boundary)", () => {
  assert.equal(classifyFacebookPostAgeZone(hoursAgo(72), now), "FRESH");
});

test("D. an unparseable/missing publishedAt is UNKNOWN, never OLD, and stays eligible", () => {
  assert.equal(classifyFacebookPostAgeZone(null, now), "UNKNOWN");
  assert.equal(classifyFacebookPostAgeZone(undefined, now), "UNKNOWN");
  assert.equal(classifyFacebookPostAgeZone("not-a-date", now), "UNKNOWN");
  assert.equal(isEligibleForCurrentProcessing("UNKNOWN"), true);
});

test("E. a fresh 2h post is eligible", () => {
  assert.equal(classifyFacebookPostAgeZone(hoursAgo(2), now), "FRESH");
});

test("a future/clock-skewed timestamp is never penalized as OLD", () => {
  assert.equal(classifyFacebookPostAgeZone(new Date(now + 3_600_000).toISOString(), now), "FRESH");
});
