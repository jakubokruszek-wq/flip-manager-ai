import assert from "node:assert/strict";
import test from "node:test";
import { isHighPriorityFacebookListing } from "./listing-priority.ts";

const base = {
  opportunityScore: 0,
  flipScore: 0,
  priceSuspect: false,
  sellerType: null as "private" | "agency" | null,
  condition: null as "renovation" | "ready" | null,
  listingIntent: "SELL_PROPERTY",
  decisionBucket: "MATCHED" as const,
  lifecycleStatus: "ACTIVE",
};

test("high priority requires a strong active sale score", () => {
  assert.equal(isHighPriorityFacebookListing({ ...base, opportunityScore: 85 }), true);
  assert.equal(isHighPriorityFacebookListing({ ...base, opportunityScore: 84, flipScore: 84 }), false);
});

test("private renovation is high priority only with a meaningful score", () => {
  assert.equal(isHighPriorityFacebookListing({ ...base, sellerType: "private", condition: "renovation", opportunityScore: 65 }), true);
  assert.equal(isHighPriorityFacebookListing({ ...base, sellerType: "private", condition: "renovation", opportunityScore: 64 }), false);
});

test("rejected or suspect listings never receive the high-priority badge", () => {
  assert.equal(isHighPriorityFacebookListing({ ...base, sellerType: "private", condition: "renovation", opportunityScore: 90, decisionBucket: "REJECTED", lifecycleStatus: "REJECTED" }), false);
  assert.equal(isHighPriorityFacebookListing({ ...base, opportunityScore: 95, priceSuspect: true }), false);
  assert.equal(isHighPriorityFacebookListing({ ...base, listingIntent: "RENT_PROPERTY", opportunityScore: 95 }), false);
});
