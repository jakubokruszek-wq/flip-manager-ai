import assert from "node:assert/strict";
import test from "node:test";
import {
  FACEBOOK_SCAN_PRIMARY_OUTCOMES,
  aggregateFacebookScanAccounting,
  classifyExtractionException,
  classifyFacebookDecision,
  classifyFacebookSkip,
  classifyPreExtractionExclusion,
  explainPartialFacebookScan,
  topFacebookScanReasons,
  verifyFacebookScanAccountingInvariant,
  type FacebookPostOutcome,
} from "./scan-accounting.ts";

// 1 & 2: every unique captured post receives exactly one primary outcome, and
// the sum of every bucket equals unique captured — for a realistic mixed
// population spanning every family in the taxonomy.
test("1&2: every classifier returns exactly one primary outcome, and the funnel sums to unique captured", () => {
  const outcomes: FacebookPostOutcome[] = [
    classifyPreExtractionExclusion({ identityConfidence: "UNVERIFIED", identityConflict: false, fresh: true })!,
    classifyPreExtractionExclusion({ identityConfidence: "EXACT", identityConflict: false, fresh: false })!,
    classifyFacebookSkip({ reasonCode: "FACEBOOK_RENT_REQUEST", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_BUY_REQUEST", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_NON_APARTMENT_PROPERTY", warnings: [] }),
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm", "area_max"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REVIEW", reasons: [], unknownFields: ["topFloor", "buildingType"] }),
    classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] }),
    classifyExtractionException("FACEBOOK_METADATA_PERSIST_FAILED"),
  ];
  for (const outcome of outcomes) {
    assert.ok(FACEBOOK_SCAN_PRIMARY_OUTCOMES.includes(outcome.primaryOutcome), `${outcome.primaryOutcome} must be a taxonomy member`);
  }
  const accounting = aggregateFacebookScanAccounting(outcomes, outcomes.length);
  assert.equal(verifyFacebookScanAccountingInvariant(accounting), true);
  assert.equal(accounting.uniqueCaptured, outcomes.length);
  assert.deepEqual(accounting.byOutcome, {
    IDENTITY_UNVERIFIED: 1, STALE_POST: 1, EXTRACTION_FAILED: 1, RENTAL: 1, NON_SALE: 1,
    UNSUPPORTED_PROPERTY_TYPE: 1, HARD_FILTER_REJECT: 1, REVIEW: 1, MATCHED: 1,
  });
});

// 3: secondary reasons can overlap (multiple reasons per post, and the same
// reason across multiple posts) without corrupting the primary total.
test("3: overlapping secondary reasons never corrupt the primary outcome total", () => {
  const outcomes: FacebookPostOutcome[] = [
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm", "area_max", "rooms"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REVIEW", reasons: [], unknownFields: ["topFloor", "buildingType", "ownership"] }),
  ];
  const accounting = aggregateFacebookScanAccounting(outcomes, 3);
  assert.equal(accounting.byOutcome.HARD_FILTER_REJECT, 2, "two REJECTED posts must count as exactly two hard rejects, regardless of how many reasons each carries");
  assert.equal(accounting.byOutcome.REVIEW, 1);
  assert.equal(verifyFacebookScanAccountingInvariant(accounting), true);
  assert.equal(accounting.reasonCounts.max_price_per_sqm, 2, "a reason shared by two posts must be counted twice, exceeding the 2 hard-rejected posts' own count is impossible here but reason totals are independent of unique-post totals");
  assert.equal(accounting.reasonCounts.area_max, 1);
  assert.equal(accounting.reasonCounts.rooms, 1);
});

// 8: a rental example can never be promoted to a sale outcome.
test("8: a deterministic rental post is classified RENTAL, never REVIEW/MATCHED/HARD_FILTER_REJECT", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "FACEBOOK_RENT_REQUEST", warnings: [] });
  assert.equal(outcome.primaryOutcome, "RENTAL");
  assert.deepEqual(outcome.reasonCodes, ["rent_request"]);
});

// 9: a house example can never become an apartment MATCHED outcome.
test("9: a non-apartment property type is classified UNSUPPORTED_PROPERTY_TYPE, never MATCHED", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "FACEBOOK_NON_APARTMENT_PROPERTY", warnings: [] });
  assert.equal(outcome.primaryOutcome, "UNSUPPORTED_PROPERTY_TYPE");
  assert.notEqual(outcome.primaryOutcome, "MATCHED");
});

// 10: a malformed/insufficient post still fails closed (never silently becomes MATCHED/REVIEW).
test("10: insufficient real-estate signal fails closed as EXTRACTION_FAILED, never MATCHED or REVIEW", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS", warnings: [] });
  assert.equal(outcome.primaryOutcome, "EXTRACTION_FAILED");
  assert.deepEqual(outcome.reasonCodes, ["insufficient_text"]);
  const unknown = classifyFacebookSkip({ reasonCode: undefined, warnings: [] });
  assert.equal(unknown.primaryOutcome, "EXTRACTION_FAILED", "an unrecognized/unclassified skip must never be silently dropped into a passing bucket");
});

// 11: price/m² reason count aggregates correctly across multiple rejected posts.
test("11: max_price_per_sqm reason count aggregates across multiple hard-rejected posts", () => {
  const outcomes = [
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm", "area_min"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] }),
  ];
  const accounting = aggregateFacebookScanAccounting(outcomes, 3);
  assert.equal(accounting.reasonCounts.max_price_per_sqm, 2);
  assert.equal(accounting.reasonCounts.area_min, 1);
  const top = topFacebookScanReasons(accounting);
  assert.equal(top[0].reason, "max_price_per_sqm");
  assert.equal(top[0].count, 2);
});

// 12: outside-Łódź reason count works, mapped from the apartment-safety warning code.
test("12: outside-Łódź secondary reason is counted under the mission's lowercase vocabulary", () => {
  const outcome = classifyFacebookSkip({ reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED", warnings: ["FACEBOOK_LOCATION_OUTSIDE_LODZ"] });
  assert.equal(outcome.primaryOutcome, "HARD_FILTER_REJECT");
  assert.ok(outcome.reasonCodes.includes("outside_lodz"));
  const accounting = aggregateFacebookScanAccounting([outcome], 1);
  assert.equal(accounting.reasonCounts.outside_lodz, 1);
});

// 13: kamienica / building-type-excluded reason counts work the same way.
test("13: kamienica and building_type_excluded secondary reasons are counted distinctly", () => {
  const kamienica = classifyFacebookSkip({ reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED", warnings: ["FACEBOOK_BUILDING_KAMIENICA"] });
  const excluded = classifyFacebookSkip({ reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED", warnings: ["FACEBOOK_BUILDING_TYPE_EXCLUDED"] });
  const accounting = aggregateFacebookScanAccounting([kamienica, excluded], 2);
  assert.equal(accounting.reasonCounts.kamienica, 1);
  assert.equal(accounting.reasonCounts.building_type_excluded, 1);
  assert.equal(accounting.byOutcome.HARD_FILTER_REJECT, 2);
});

// 14: the partial-scan explanation is built from real counters, never a hardcoded example.
test("14: explainPartialFacebookScan reflects the scan's own real counters, and degrades gracefully without accounting", () => {
  const accounting = aggregateFacebookScanAccounting([
    classifyPreExtractionExclusion({ identityConfidence: "UNVERIFIED", identityConflict: false, fresh: true })!,
    ...Array.from({ length: 21 }, () => classifyPreExtractionExclusion({ identityConfidence: "UNVERIFIED", identityConflict: false, fresh: true })!),
    ...Array.from({ length: 19 }, () => classifyExtractionException("FACEBOOK_POST_EXTRACTION_FAILED")),
    classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] }),
  ], 100);
  const explanation = explainPartialFacebookScan(accounting, 1);
  assert.deepEqual(explanation, [
    `${accounting.uniqueCaptured} zebranych`,
    "22 niezweryfikowane tożsamości",
    "19 błędy ekstrakcji",
    "1 źródło zakończone w trybie degraded",
  ]);
  assert.deepEqual(explainPartialFacebookScan(null), [], "a historical scan with no accounting must degrade to an empty explanation, never throw or fabricate numbers");
});

// 15: the accounting invariant holds across a comprehensive population spanning MATCHED, REVIEW, hard rejects, technical failures, and non-sale posts together.
test("15: the accounting invariant holds across a comprehensive, realistic mixed population", () => {
  const outcomes: FacebookPostOutcome[] = [
    classifyPreExtractionExclusion({ identityConfidence: "UNVERIFIED", identityConflict: false, fresh: true })!,
    classifyPreExtractionExclusion({ identityConfidence: "EXACT", identityConflict: true, fresh: true })!,
    classifyPreExtractionExclusion({ identityConfidence: "EXACT", identityConflict: false, fresh: false })!,
    classifyFacebookSkip({ reasonCode: "FACEBOOK_RENT_REQUEST", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_BUY_REQUEST", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_SERVICE_POST", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_INTENT_UNKNOWN", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_NON_APARTMENT_PROPERTY", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS", warnings: [] }),
    classifyFacebookSkip({ reasonCode: "FACEBOOK_PROPERTY_FILTER_REJECTED", warnings: ["FACEBOOK_BUILDING_KAMIENICA"] }),
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REJECTED", reasons: ["area_max", "rooms"], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "REVIEW", reasons: [], unknownFields: ["topFloor"] }),
    classifyFacebookDecision({ bucket: "REVIEW", reasons: [], unknownFields: ["buildingType", "ownership"] }),
    classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] }),
    classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] }),
    classifyExtractionException("FACEBOOK_METADATA_PERSIST_FAILED"),
    classifyExtractionException("FACEBOOK_POST_EXTRACTION_FAILED"),
  ];
  const accounting = aggregateFacebookScanAccounting(outcomes, outcomes.length + 5);
  assert.equal(verifyFacebookScanAccountingInvariant(accounting), true);
  assert.equal(accounting.uniqueCaptured, outcomes.length);
  assert.equal(accounting.duplicatesRemoved, 5, "raw captured minus unique captured must reflect removed duplicates, distinct from the outcome funnel");
  assert.equal(accounting.byOutcome.IDENTITY_UNVERIFIED, 2);
  assert.equal(accounting.byOutcome.STALE_POST, 1);
  assert.equal(accounting.byOutcome.RENTAL, 1);
  assert.equal(accounting.byOutcome.NON_SALE, 3);
  assert.equal(accounting.byOutcome.UNSUPPORTED_PROPERTY_TYPE, 1);
  assert.equal(accounting.byOutcome.HARD_FILTER_REJECT, 3);
  assert.equal(accounting.byOutcome.REVIEW, 2);
  assert.equal(accounting.byOutcome.MATCHED, 2);
  assert.equal(accounting.byOutcome.EXTRACTION_FAILED, 3, "one insufficient-text skip plus two thrown exceptions");
});

test("no post can appear in two primary terminal buckets: aggregation is a partition, not a multi-count", () => {
  // Every classifier call above returns ONE FacebookPostOutcome with ONE
  // primaryOutcome; aggregateFacebookScanAccounting increments exactly one
  // counter per outcome. This test proves that structurally: the sum of all
  // buckets can never exceed the number of input outcomes.
  const outcomes: FacebookPostOutcome[] = Array.from({ length: 50 }, (_, index) =>
    index % 2 === 0
      ? classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] })
      : classifyFacebookDecision({ bucket: "REJECTED", reasons: ["max_price_per_sqm"], unknownFields: [] }));
  const accounting = aggregateFacebookScanAccounting(outcomes, 50);
  const sum = Object.values(accounting.byOutcome).reduce((total, value) => total + value, 0);
  assert.equal(sum, 50);
  assert.equal(accounting.byOutcome.MATCHED, 25);
  assert.equal(accounting.byOutcome.HARD_FILTER_REJECT, 25);
});
