import assert from "node:assert/strict";
import test from "node:test";
import { ALERT_TYPES, isPushEligibleAlertType } from "./types.ts";

test("new_listing is the only alert type that is never push-eligible", () => {
  for (const type of ALERT_TYPES) {
    assert.equal(isPushEligibleAlertType(type), type !== "new_listing", `unexpected eligibility for ${type}`);
  }
});

test("canonical_match, facebook_opportunity, high_flip_score, private_seller and price_drop are all push-eligible", () => {
  for (const type of ["canonical_match", "facebook_opportunity", "high_flip_score", "private_seller", "price_drop"] as const) {
    assert.equal(isPushEligibleAlertType(type), true);
  }
});
