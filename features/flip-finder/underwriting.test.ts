import assert from "node:assert/strict";
import test from "node:test";
import { calculateUnderwriting, DEFAULT_UNDERWRITING_SETTINGS, validateMaxPurchaseBoundary, type UnderwritingInput } from "./underwriting.ts";

const base: UnderwritingInput = {
  listingId: "real", source: "facebook", sourceUrl: "https://facebook.com/groups/1/posts/2", lifecycleStatus: "ACTIVE", decisionBucket: "MATCHED", manualDecision: null,
  city: "Łódź", district: "Chojny", street: "Ogniskowa 8", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "blok", yearBuilt: null, ownership: "pełna własność", condition: "do remontu", monthlyFee: null,
  askingPrice: 300_000, askingPricePerM2: null, resalePerM2: { low: 9_500, base: 10_000, high: 10_500, provenance: "DERIVED", confidence: 80 }, renovationMode: "FULL", missingFields: [], galleryAvailable: false,
};

test("canonical money math and three scenarios are deterministic", () => {
  const result = calculateUnderwriting(base, { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 2_000 } });
  assert.equal(result.scenarios.base.resaleValue, 450_000);
  assert.equal(result.renovationTotal, 90_000);
  assert.equal(result.purchaseTransactionCosts, 9_500);
  assert.equal(result.contingency, 9_000);
  assert.equal(result.holdingCosts, 9_000);
  assert.equal(result.salesCosts, 9_000);
  assert.equal(result.totalProjectCost, 426_500);
  assert.equal(result.profitBase, 23_500);
  assert.equal(result.marginBase, 5.22);
  assert.equal(result.roiBase, 5.51);
  assert.ok(result.profitLow! < result.profitBase! && result.profitBase! < result.profitHigh!);
});

test("max buy satisfies profit and margin together and target adds safety buffer", () => {
  const result = calculateUnderwriting(base, { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 2_000 } });
  assert.equal(result.maxPurchasePrice, 270_098.04);
  assert.equal(result.targetPurchasePrice, 256_593.14);
  assert.equal(result.decision, "TOO_EXPENSIVE");
});

test("price drop below max recalculates too expensive into good", () => {
  const settings = { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 1_000 }, minimumProfitPLN: 30_000, minimumMarginPercent: 8, minimumROI: 8 };
  assert.equal(calculateUnderwriting({ ...base, askingPrice: 350_000 }, settings).decision, "TOO_EXPENSIVE");
  assert.match(calculateUnderwriting({ ...base, askingPrice: 250_000 }, settings).decision, /GOOD|HOT/);
});

test("strong economics with missing building and ownership remains review with lower confidence", () => {
  const result = calculateUnderwriting({ ...base, askingPrice: 200_000, buildingType: null, ownership: null }, { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 1_000 } });
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.confidenceScore < 80);
  assert.ok(result.flipScore > 0);
});

test("manual reject wins regardless of economics", () => assert.equal(calculateUnderwriting({ ...base, askingPrice: 100_000, manualDecision: "REJECTED" }).decision, "REJECT"));
test("missing resale assumption never fabricates profit", () => {
  const result = calculateUnderwriting({ ...base, resalePerM2: undefined }, { ...DEFAULT_UNDERWRITING_SETTINGS, marketResalePerM2: { low: 0, base: 0, high: 0 } });
  assert.equal(result.profitBase, null);
  assert.equal(result.decision, "REVIEW");
  assert.ok(result.missingFields.includes("resale"));
});
test("gallery failure does not affect financial underwriting", () => {
  const without = calculateUnderwriting({ ...base, galleryAvailable: false });
  const withGallery = calculateUnderwriting({ ...base, galleryAvailable: true });
  assert.equal(without.profitBase, withGallery.profitBase);
  assert.equal(without.maxPurchasePrice, withGallery.maxPurchasePrice);
});
test("review plus manual acceptance enters the accepted decision path without gallery", () => {
  const settings = { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 1_000 }, minimumProfitPLN: 30_000, minimumMarginPercent: 8, minimumROI: 8 };
  const result = calculateUnderwriting({ ...base, askingPrice: 200_000, lifecycleStatus: "REVIEW", decisionBucket: "REVIEW", manualDecision: "ACCEPTED", buildingType: null, ownership: null, galleryAvailable: false }, settings);
  assert.match(result.decision, /GOOD|HOT/);
});
test("overrides preserve source values externally and change only effective calculation", () => {
  const result = calculateUnderwriting({ ...base, priceOverride: 250_000, resalePerM2Override: 11_000, holdingMonthsOverride: 4, additionalCostsOverride: 5_000 });
  assert.equal(result.purchasePrice, 250_000);
  assert.equal(result.provenance.askingPrice, "USER_ASSUMPTION");
  assert.equal(base.askingPrice, 300_000);
});
test("edited market resale is auditable as a user assumption", () => {
  const result = calculateUnderwriting({ ...base, resalePerM2: undefined }, { ...DEFAULT_UNDERWRITING_SETTINGS, marketResalePerM2: { low: 9_000, base: 10_000, high: 11_000 }, marketResaleProvenance: "USER_ASSUMPTION" });
  assert.equal(result.provenance.resalePricePerM2, "USER_ASSUMPTION");
  assert.equal(result.scenarios.base.resalePerM2, 10_000);
});

test("max buy includes ROI and independent boundary validation", () => {
  const settings = { ...DEFAULT_UNDERWRITING_SETTINGS, renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 1_000 }, minimumProfitPLN: 1_000, minimumMarginPercent: 1, minimumROI: 50 };
  const result = calculateUnderwriting(base, settings);
  assert.equal(validateMaxPurchaseBoundary(base, settings, result.maxPurchasePrice).status, "PASS");
  const withoutRoi = calculateUnderwriting(base, { ...settings, minimumROI: 0 });
  assert.ok(result.maxPurchasePrice! < withoutRoi.maxPurchasePrice!);
});
