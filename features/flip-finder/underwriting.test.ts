import assert from "node:assert/strict";
import test from "node:test";
import { calculateMaxPurchaseForThresholds, calculateUnderwriting, DEFAULT_UNDERWRITING_SETTINGS, validateMaxPurchaseBoundary, type MaxPurchaseThresholds, type UnderwritingInput } from "./underwriting.ts";

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

test("MAX BUY A-H matrix proves exact one-grosz boundaries for every active threshold combination", () => {
  const thresholds: MaxPurchaseThresholds[] = [
    { profit: false, margin: false, roi: false },
    { profit: true, margin: false, roi: false },
    { profit: false, margin: true, roi: false },
    { profit: false, margin: false, roi: true },
    { profit: true, margin: true, roi: false },
    { profit: true, margin: false, roi: true },
    { profit: false, margin: true, roi: true },
    { profit: true, margin: true, roi: true },
  ];
  const settings = { ...DEFAULT_UNDERWRITING_SETTINGS, financingEnabled: true, financingLoanPercent: 65, financingAnnualRatePercent: 8.75, purchaseTaxPercent: 2, purchaseCommissionPercent: 1.15, salesCostPercent: 2.25, minimumProfitPLN: 35_000, minimumMarginPercent: 11.5, minimumROI: 14.25 };
  for (const [index, active] of thresholds.entries()) {
    const maximum = calculateMaxPurchaseForThresholds(base, settings, active);
    assert.ok(maximum !== null && maximum > 0, `case ${String.fromCharCode(65 + index)}`);
    const boundary = validateMaxPurchaseBoundary(base, settings, maximum, active);
    assert.equal(boundary.status, "PASS", `case ${String.fromCharCode(65 + index)}: ${JSON.stringify(boundary.checks)}`);
    assert.match(boundary.checks[0]!.detail, /delta=-0\.01 PLN/);
    assert.match(boundary.checks[1]!.detail, /delta=\+0\.01 PLN/);
  }
});

test("impossible MAX BUY inputs are reported without claiming a passing boundary", () => {
  const settings = { ...DEFAULT_UNDERWRITING_SETTINGS, minimumProfitPLN: 1_000_000, minimumMarginPercent: 0, minimumROI: 0 };
  const thresholds = { profit: true, margin: false, roi: false };
  const maximum = calculateMaxPurchaseForThresholds(base, settings, thresholds);
  assert.equal(maximum, 0);
  assert.equal(validateMaxPurchaseBoundary(base, settings, maximum, thresholds).status, "FAIL");
});

test("deterministic property fuzz agrees on independent MAX BUY boundaries with tax, fees and financing", () => {
  let seed = 0x5eed1234;
  const random = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed / 0x1_0000_0000; };
  const thresholdSets: MaxPurchaseThresholds[] = [
    { profit: false, margin: false, roi: false },
    { profit: true, margin: false, roi: false }, { profit: false, margin: true, roi: false },
    { profit: false, margin: false, roi: true }, { profit: true, margin: true, roi: false },
    { profit: true, margin: false, roi: true }, { profit: false, margin: true, roi: true },
    { profit: true, margin: true, roi: true },
  ];
  for (let index = 0; index < 350; index += 1) {
    const areaM2 = 30 + Math.round(random() * 5_000) / 100;
    const resaleBase = 7_500 + Math.round(random() * 6_000);
    const current = { ...base, areaM2, resalePerM2: { low: resaleBase - 300, base: resaleBase, high: resaleBase + 400, provenance: "DERIVED" as const, confidence: 70 } };
    const settings = {
      ...DEFAULT_UNDERWRITING_SETTINGS,
      financingEnabled: random() > 0.4,
      financingLoanPercent: Math.round(random() * 10_000) / 100,
      financingAnnualRatePercent: Math.round(random() * 2_000) / 100,
      purchaseTaxPercent: Math.round(random() * 500) / 100,
      purchaseCommissionPercent: Math.round(random() * 500) / 100,
      salesCostPercent: Math.round(random() * 500) / 100,
      minimumProfitPLN: Math.round(5_000 + random() * 50_000),
      minimumMarginPercent: Math.round(random() * 2_500) / 100,
      minimumROI: Math.round(random() * 4_000) / 100,
      holdingMonths: 1 + Math.round(random() * 23) / 2,
    };
    const active = thresholdSets[Math.floor(random() * thresholdSets.length)]!;
    const maximum = calculateMaxPurchaseForThresholds(current, settings, active);
    if (maximum === null || maximum <= 0) continue;
    assert.equal(validateMaxPurchaseBoundary(current, settings, maximum, active).status, "PASS", `fuzz case ${index}`);
  }
});

test("underwriter public amounts remain cent-exact with rounded tax, commission, reserve, finance and sale fees", () => {
  const result = calculateUnderwriting({ ...base, areaM2: 45.01, askingPrice: 300_000.01, askingPricePerM2: null, holdingMonthsOverride: 6 }, {
    ...DEFAULT_UNDERWRITING_SETTINGS,
    fixedPurchaseCosts: 1_234.56,
    renovationPerM2: { ...DEFAULT_UNDERWRITING_SETTINGS.renovationPerM2, FULL: 1_111.11 },
    contingencyPercent: 12.5,
    purchaseTaxPercent: 2,
    purchaseCommissionPercent: 1.25,
    financingEnabled: true,
    financingLoanPercent: 65,
    financingAnnualRatePercent: 9.5,
    salesCostPercent: 2.5,
  });
  for (const value of [result.renovationTotal, result.purchaseTransactionCosts, result.holdingCosts, result.financingCosts, result.salesCosts, result.contingency, result.totalProjectCost, result.profitBase, result.maxPurchasePrice]) {
    if (value !== null) assert.equal(Number.isInteger(Math.round(value * 100)), true);
  }
  assert.equal(result.purchaseTransactionCosts, 10_984.56);
  assert.equal(result.renovationTotal, 50_011.06);
  assert.equal(result.contingency, 6_251.38);
  assert.equal(result.financingCosts, 9_262.50);
});

test("maximum supported separate purchase tax and commission rates stay within the settings domain", () => {
  const result = calculateUnderwriting(base, {
    ...DEFAULT_UNDERWRITING_SETTINGS,
    purchaseTaxPercent: 100,
    purchaseCommissionPercent: 100,
  });
  assert.equal(result.purchaseTransactionCosts, base.askingPrice! * 2 + DEFAULT_UNDERWRITING_SETTINGS.fixedPurchaseCosts);
});
