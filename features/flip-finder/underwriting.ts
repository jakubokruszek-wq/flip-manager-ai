import { addMoney, divideMoneyByQuantity, moneyCents, moneyToPLN, multiplyByFraction, multiplyByRate, multiplyMoneyByQuantity, percentToBasisPoints, subtractMoney, type BasisPoints, type MoneyCents } from "../investment-os/money.ts";

export const UNDERWRITING_DECISIONS = ["HOT", "GOOD", "REVIEW", "TOO_EXPENSIVE", "REJECT"] as const;
export type UnderwritingDecision = (typeof UNDERWRITING_DECISIONS)[number];
export type ValueProvenance = "EXTRACTED" | "DERIVED" | "USER_ASSUMPTION" | "MARKET_ASSUMPTION" | "MANUAL_OVERRIDE" | "UNKNOWN";
export type RenovationMode = "LIGHT" | "STANDARD" | "FULL";

export type UnderwritingSettings = {
  renovationPerM2: Record<RenovationMode, number>;
  contingencyPercent: number;
  purchaseTaxPercent: number;
  fixedPurchaseCosts: number;
  purchaseCommissionPercent: number;
  holdingMonths: number;
  monthlyHoldingCost: number;
  financingEnabled: boolean;
  financingAnnualRatePercent: number;
  financingLoanPercent: number;
  salesCostPercent: number;
  minimumProfitPLN: number;
  minimumMarginPercent: number;
  minimumROI: number;
  targetNegotiationBufferPercent: number;
  marketResalePerM2: { low: number; base: number; high: number };
  marketResaleProvenance: "MARKET_ASSUMPTION" | "USER_ASSUMPTION";
};

export const DEFAULT_UNDERWRITING_SETTINGS: UnderwritingSettings = {
  renovationPerM2: { LIGHT: 1_000, STANDARD: 1_800, FULL: 2_700 },
  contingencyPercent: 10,
  purchaseTaxPercent: 2,
  fixedPurchaseCosts: 3_500,
  purchaseCommissionPercent: 0,
  holdingMonths: 6,
  monthlyHoldingCost: 1_500,
  financingEnabled: false,
  financingAnnualRatePercent: 9,
  financingLoanPercent: 70,
  salesCostPercent: 2,
  minimumProfitPLN: 50_000,
  minimumMarginPercent: 12,
  minimumROI: 12,
  targetNegotiationBufferPercent: 5,
  marketResalePerM2: { low: 8_500, base: 9_500, high: 10_500 },
  marketResaleProvenance: "MARKET_ASSUMPTION",
};

export type UnderwritingInput = {
  listingId: string;
  source: string;
  sourceUrl: string;
  lifecycleStatus: string | null;
  decisionBucket: "MATCHED" | "REVIEW" | "REJECTED";
  manualDecision: "ACCEPTED" | "REJECTED" | null;
  city: string | null;
  district: string | null;
  street: string | null;
  areaM2: number | null;
  rooms: number | null;
  floor: string | null;
  floorsTotal: string | null;
  buildingType: string | null;
  yearBuilt: number | null;
  ownership: string | null;
  condition: string | null;
  monthlyFee: number | null;
  askingPrice: number | null;
  askingPricePerM2: number | null;
  resalePerM2?: { low: number | null; base: number | null; high: number | null; provenance: ValueProvenance; confidence: number };
  renovationMode?: RenovationMode;
  missingFields?: string[];
  galleryAvailable?: boolean;
  priceOverride?: number | null;
  resalePerM2Override?: number | null;
  renovationPerM2Override?: number | null;
  holdingMonthsOverride?: number | null;
  additionalCostsOverride?: number | null;
};

export type UnderwritingScenario = {
  resalePerM2: number | null;
  resaleValue: number | null;
  renovationTotal: number | null;
  totalProjectCost: number | null;
  profit: number | null;
};

export type UnderwritingResult = {
  listingId: string;
  provenance: Record<string, ValueProvenance>;
  purchasePrice: number | null;
  askingPricePerM2: number | null;
  renovationMode: RenovationMode;
  renovationPerM2: number;
  renovationTotal: number | null;
  purchaseTransactionCosts: number | null;
  holdingCosts: number;
  financingCosts: number | null;
  salesCosts: number | null;
  contingency: number | null;
  totalProjectCost: number | null;
  scenarios: { conservative: UnderwritingScenario; base: UnderwritingScenario; optimistic: UnderwritingScenario };
  profitLow: number | null;
  profitBase: number | null;
  profitHigh: number | null;
  marginBase: number | null;
  roiBase: number | null;
  maxPurchasePrice: number | null;
  targetPurchasePrice: number | null;
  discountNeeded: number | null;
  discountNeededPercent: number | null;
  flipScore: number;
  confidenceScore: number;
  decision: UnderwritingDecision;
  scoreComponents: Array<{ label: string; points: number }>;
  redFlags: string[];
  strengths: string[];
  missingFields: string[];
  resaleConfidence: number;
};

export type MaxPurchaseBoundaryValidation = {
  status: "PASS" | "FAIL" | "BLOCKED";
  checks: Array<{ code: string; passed: boolean; detail: string }>;
};

export type MaxPurchaseThresholds = { profit: boolean; margin: boolean; roi: boolean };
const ALL_MAX_PURCHASE_THRESHOLDS: MaxPurchaseThresholds = { profit: true, margin: true, roi: true };

type FinanceConfig = {
  fixedPurchaseCosts: MoneyCents;
  monthlyHoldingCost: MoneyCents;
  contingencyRate: BasisPoints;
  purchaseTaxRate: BasisPoints;
  purchaseCommissionRate: BasisPoints;
  financingLoanRate: BasisPoints;
  financingAnnualRate: BasisPoints;
  salesRate: BasisPoints;
  minimumProfit: MoneyCents;
  minimumMargin: BasisPoints;
  minimumROI: BasisPoints;
  targetBuffer: BasisPoints;
  holdingMonths: number;
  financingEnabled: boolean;
};

type InternalScenario = {
  resalePerM2: MoneyCents | null;
  resaleValue: MoneyCents | null;
  renovationTotal: MoneyCents | null;
  totalProjectCost: MoneyCents | null;
  profit: MoneyCents | null;
  purchaseCosts: MoneyCents | null;
  financingCosts: MoneyCents | null;
  contingency: MoneyCents | null;
  salesCosts: MoneyCents | null;
};

/** All PLN arithmetic is rounded through integer grosze at every monetary boundary. */
export function calculateUnderwriting(input: UnderwritingInput, settings: UnderwritingSettings = DEFAULT_UNDERWRITING_SETTINGS): UnderwritingResult {
  const area = positive(input.areaM2);
  const sourcePrice = positive(input.askingPrice);
  const sourcePriceCents = sourcePrice === null ? null : moneyCents(sourcePrice);
  const purchasePriceCents = positive(input.priceOverride) === null ? sourcePriceCents : moneyCents(input.priceOverride!);
  const renovationMode = input.renovationMode ?? inferRenovationMode(input.condition);
  const renovationPerM2 = positive(input.renovationPerM2Override) ?? settings.renovationPerM2[renovationMode];
  const renovationPerM2Cents = moneyCents(renovationPerM2);
  const holdingMonths = nonnegative(input.holdingMonthsOverride) ?? settings.holdingMonths;
  const additionalCostsCents = moneyCents(nonnegative(input.additionalCostsOverride) ?? 0);
  const finance = financeConfig(settings, holdingMonths);
  const resale = effectiveResale(input, settings);
  const renovationBaseCents = area === null ? null : multiplyMoneyByQuantity(renovationPerM2Cents, area);
  const conservativeRenovationCents = renovationBaseCents === null ? null : multiplyByFraction(renovationBaseCents, BigInt(115), BigInt(100));
  const optimisticRenovationCents = renovationBaseCents === null ? null : multiplyByFraction(renovationBaseCents, BigInt(95), BigInt(100));
  const holdingCostsCents = multiplyMoneyByQuantity(finance.monthlyHoldingCost, holdingMonths);
  const baseScenarioCents = scenarioCents(purchasePriceCents, area, resale.base, renovationBaseCents, holdingCostsCents, additionalCostsCents, finance);
  const conservativeCents = scenarioCents(purchasePriceCents, area, resale.low, conservativeRenovationCents, holdingCostsCents, additionalCostsCents, finance);
  const optimisticCents = scenarioCents(purchasePriceCents, area, resale.high, optimisticRenovationCents, holdingCostsCents, additionalCostsCents, finance);
  const maxPurchaseCents = maxBuyCents(area, resale.base, renovationBaseCents, holdingCostsCents, additionalCostsCents, finance, ALL_MAX_PURCHASE_THRESHOLDS);
  const targetPurchaseCents = maxPurchaseCents === null ? null : multiplyByRate(maxPurchaseCents, (10_000 - Number(finance.targetBuffer)) as BasisPoints);
  const discountNeededCents = sourcePriceCents !== null && targetPurchaseCents !== null ? (subtractMoney(sourcePriceCents, targetPurchaseCents) > 0 ? subtractMoney(sourcePriceCents, targetPurchaseCents) : moneyCents(0)) : null;
  const discountNeededPercent = discountNeededCents !== null && sourcePriceCents !== null ? ratioCents(discountNeededCents, sourcePriceCents) : null;
  const marginBase = baseScenarioCents.profit !== null && baseScenarioCents.resaleValue !== null ? ratioCents(baseScenarioCents.profit, baseScenarioCents.resaleValue) : null;
  const roiBase = baseScenarioCents.profit !== null && baseScenarioCents.totalProjectCost !== null ? ratioCents(baseScenarioCents.profit, baseScenarioCents.totalProjectCost) : null;
  const baseScenario = toPublicScenario(baseScenarioCents);
  const conservative = toPublicScenario(conservativeCents);
  const optimistic = toPublicScenario(optimisticCents);
  const purchasePrice = purchasePriceCents === null ? null : moneyToPLN(purchasePriceCents);
  const maxPurchasePrice = maxPurchaseCents === null ? null : moneyToPLN(maxPurchaseCents);
  const targetPurchasePrice = targetPurchaseCents === null ? null : moneyToPLN(targetPurchaseCents);
  const discountNeeded = discountNeededCents === null ? null : moneyToPLN(discountNeededCents);
  const renovationTotal = renovationBaseCents === null ? null : moneyToPLN(renovationBaseCents);
  const holdingCosts = moneyToPLN(holdingCostsCents);
  const missingFields = collectMissing(input, resale.base);
  const confidenceScore = confidence(input, resale.confidence, missingFields);
  const scored = score({ input, sourcePriceCents, maxPurchaseCents, profitCents: baseScenarioCents.profit, marginBase, roiBase, confidenceScore });
  const decision = decide(input, sourcePriceCents, maxPurchaseCents, baseScenarioCents, confidenceScore, missingFields, finance);
  const purchaseCosts = baseScenarioCents.purchaseCosts === null ? null : moneyToPLN(baseScenarioCents.purchaseCosts);
  const financingCosts = baseScenarioCents.financingCosts === null ? null : moneyToPLN(baseScenarioCents.financingCosts);
  const contingency = baseScenarioCents.contingency === null ? null : moneyToPLN(baseScenarioCents.contingency);
  const salesCosts = baseScenarioCents.salesCosts === null ? null : moneyToPLN(baseScenarioCents.salesCosts);
  const askingPricePerM2Cents = positive(input.askingPricePerM2) !== null
    ? moneyCents(input.askingPricePerM2!)
    : sourcePriceCents !== null && area !== null ? divideMoneyByQuantity(sourcePriceCents, area) : null;
  return {
    listingId: input.listingId,
    provenance: {
      askingPrice: sourcePrice === null ? "UNKNOWN" : input.priceOverride ? "USER_ASSUMPTION" : "EXTRACTED",
      areaM2: area === null ? "UNKNOWN" : "EXTRACTED",
      rooms: positive(input.rooms) === null ? "UNKNOWN" : "EXTRACTED",
      location: input.city ? "EXTRACTED" : "UNKNOWN",
      buildingType: input.buildingType ? "EXTRACTED" : "UNKNOWN",
      ownership: input.ownership ? "EXTRACTED" : "UNKNOWN",
      resalePricePerM2: input.resalePerM2Override ? "USER_ASSUMPTION" : resale.provenance,
      renovationPerM2: input.renovationPerM2Override ? "USER_ASSUMPTION" : "USER_ASSUMPTION",
      totalProjectCost: baseScenario.totalProjectCost === null ? "UNKNOWN" : "DERIVED",
      profit: baseScenario.profit === null ? "UNKNOWN" : "DERIVED",
    },
    purchasePrice,
    askingPricePerM2: askingPricePerM2Cents === null ? null : moneyToPLN(askingPricePerM2Cents),
    renovationMode,
    renovationPerM2: moneyToPLN(renovationPerM2Cents),
    renovationTotal,
    purchaseTransactionCosts: purchaseCosts,
    holdingCosts,
    financingCosts,
    salesCosts,
    contingency,
    totalProjectCost: baseScenario.totalProjectCost,
    scenarios: { conservative, base: baseScenario, optimistic },
    profitLow: publicMoney(conservativeCents.profit),
    profitBase: publicMoney(baseScenarioCents.profit),
    profitHigh: publicMoney(optimisticCents.profit),
    marginBase,
    roiBase,
    maxPurchasePrice,
    targetPurchasePrice,
    discountNeeded,
    discountNeededPercent,
    flipScore: scored.total,
    confidenceScore,
    decision,
    scoreComponents: scored.components,
    redFlags: redFlags(input, maxPurchaseCents, sourcePriceCents, baseScenarioCents.profit, resale.confidence),
    strengths: strengths(input, baseScenarioCents.profit, marginBase, roiBase, maxPurchaseCents, sourcePriceCents),
    missingFields,
    resaleConfidence: resale.confidence,
  };
}

function scenarioCents(purchase: MoneyCents | null, area: number | null, resalePerM2: MoneyCents | null, renovation: MoneyCents | null, holding: MoneyCents, additional: MoneyCents, finance: FinanceConfig): InternalScenario {
  const resaleValue = area !== null && resalePerM2 !== null ? multiplyMoneyByQuantity(resalePerM2, area) : null;
  if (purchase === null || resaleValue === null || renovation === null) return { resalePerM2, resaleValue, renovationTotal: renovation, totalProjectCost: null, profit: null, purchaseCosts: null, financingCosts: null, contingency: null, salesCosts: null };
  const purchaseCosts = addMoney(
    finance.fixedPurchaseCosts,
    addMoney(multiplyByRate(purchase, finance.purchaseTaxRate), multiplyByRate(purchase, finance.purchaseCommissionRate)),
  );
  const financingCosts = financingCostsCents(purchase, finance, finance.holdingMonths);
  const contingency = multiplyByRate(renovation, finance.contingencyRate);
  const salesCosts = multiplyByRate(resaleValue, finance.salesRate);
  const totalProjectCost = [purchase, purchaseCosts, financingCosts, renovation, contingency, holding, additional, salesCosts].reduce(addMoney, moneyCents(0));
  return { resalePerM2, resaleValue, renovationTotal: renovation, totalProjectCost, profit: subtractMoney(resaleValue, totalProjectCost), purchaseCosts, financingCosts, contingency, salesCosts };
}

function independentValidatorScenario(purchase: MoneyCents, area: number, resalePerM2: MoneyCents, renovation: MoneyCents, holding: MoneyCents, additional: MoneyCents, finance: FinanceConfig): Pick<InternalScenario, "resaleValue" | "totalProjectCost" | "profit"> {
  // Separate validator path: reconstruct each cash flow from the raw inputs instead of calculator scenario output.
  const grossExit = multiplyMoneyByQuantity(resalePerM2, area);
  const renovationReserve = multiplyByRate(renovation, finance.contingencyRate);
  const saleFee = multiplyByRate(grossExit, finance.salesRate);
  const acquisitionTaxAndCommission = addMoney(
    multiplyByRate(purchase, finance.purchaseTaxRate),
    multiplyByRate(purchase, finance.purchaseCommissionRate),
  );
  const capitalCost = finance.financingEnabled
    ? multiplyByFraction(purchase, BigInt(finance.financingLoanRate) * BigInt(finance.financingAnnualRate) * BigInt(Math.round(finance.holdingMonths * 1_000)), BigInt(10_000) * BigInt(10_000) * BigInt(12_000))
    : moneyCents(0);
  const totalProjectCost = [purchase, finance.fixedPurchaseCosts, acquisitionTaxAndCommission, capitalCost, renovation, renovationReserve, holding, additional, saleFee].reduce(addMoney, moneyCents(0));
  return { resaleValue: grossExit, totalProjectCost, profit: subtractMoney(grossExit, totalProjectCost) };
}

function passesThresholds(value: Pick<InternalScenario, "profit" | "resaleValue" | "totalProjectCost">, finance: FinanceConfig, thresholds: MaxPurchaseThresholds): boolean {
  const checks = thresholdChecks(value, finance);
  return thresholdNames(thresholds).every((key) => checks[key]);
}

function thresholdChecks(value: Pick<InternalScenario, "profit" | "resaleValue" | "totalProjectCost">, finance: FinanceConfig): Record<keyof MaxPurchaseThresholds, boolean> {
  const profit = value.profit;
  return {
    profit: profit !== null && profit >= finance.minimumProfit,
    margin: profit !== null && value.resaleValue !== null && ratioAtLeast(profit, value.resaleValue, finance.minimumMargin),
    roi: profit !== null && value.totalProjectCost !== null && ratioAtLeast(profit, value.totalProjectCost, finance.minimumROI),
  };
}

function ratioAtLeast(numerator: MoneyCents, denominator: MoneyCents, threshold: BasisPoints): boolean {
  return denominator > 0 && BigInt(numerator) * BigInt(10_000) >= BigInt(denominator) * BigInt(threshold);
}

function thresholdNames(thresholds: MaxPurchaseThresholds): Array<keyof MaxPurchaseThresholds> {
  return (Object.keys(thresholds) as Array<keyof MaxPurchaseThresholds>).filter((key) => thresholds[key]);
}

function toPublicScenario(value: InternalScenario): UnderwritingScenario {
  return { resalePerM2: publicMoney(value.resalePerM2), resaleValue: publicMoney(value.resaleValue), renovationTotal: publicMoney(value.renovationTotal), totalProjectCost: publicMoney(value.totalProjectCost), profit: publicMoney(value.profit) };
}

function publicMoney(value: MoneyCents | null): number | null { return value === null ? null : moneyToPLN(value); }

function ratioCents(value: MoneyCents | null, base: MoneyCents | null): number | null {
  if (value === null || base === null) return null;
  if (base <= 0) return 0;
  const numerator = BigInt(value) * BigInt(10_000);
  const denominator = BigInt(base);
  const sign = numerator < BigInt(0) ? BigInt(-1) : BigInt(1);
  const magnitude = numerator < BigInt(0) ? -numerator : numerator;
  return Number(sign * ((magnitude * BigInt(2) + denominator) / (denominator * BigInt(2)))) / 100;
}

/** Calculator-side MAX BUY search. It uses calculator scenarios and cent-level binary search. */
function maxBuyCents(area: number | null, resalePerM2: MoneyCents | null, renovation: MoneyCents | null, holding: MoneyCents, additional: MoneyCents, finance: FinanceConfig, thresholds: MaxPurchaseThresholds): MoneyCents | null {
  if (area === null || resalePerM2 === null || renovation === null) return null;
  const resaleValue = multiplyMoneyByQuantity(resalePerM2, area);
  const passes = (purchase: MoneyCents) => passesThresholds(scenarioCents(purchase, area, resalePerM2, renovation, holding, additional, finance), finance, thresholds);
  let low = 0;
  let high = Number(resaleValue);
  if (!passes(moneyCents(0))) return moneyCents(0);
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (passes(middle as MoneyCents)) low = middle;
    else high = middle - 1;
  }
  return low as MoneyCents;
}

/** Exposed for the exhaustive active-threshold boundary matrix. Production underwriting uses all three criteria. */
export function calculateMaxPurchaseForThresholds(input: UnderwritingInput, settings: UnderwritingSettings, thresholds: MaxPurchaseThresholds): number | null {
  const area = positive(input.areaM2);
  const resalePerM2 = effectiveResale(input, settings).base;
  const mode = input.renovationMode ?? inferRenovationMode(input.condition);
  const perM2 = positive(input.renovationPerM2Override) ?? settings.renovationPerM2[mode];
  const renovation = area === null ? null : multiplyMoneyByQuantity(moneyCents(perM2), area);
  const months = nonnegative(input.holdingMonthsOverride) ?? settings.holdingMonths;
  const finance = financeConfig(settings, months);
  const holding = multiplyMoneyByQuantity(finance.monthlyHoldingCost, months);
  const additional = moneyCents(nonnegative(input.additionalCostsOverride) ?? 0);
  const value = maxBuyCents(area, resalePerM2, renovation, holding, additional, finance, thresholds);
  return value === null ? null : moneyToPLN(value);
}

/** Independent invariant check. It does not trust the director decision or score. */
export function validateMaxPurchaseBoundary(input: UnderwritingInput, settings: UnderwritingSettings, maxPurchasePrice: number | null, thresholds: MaxPurchaseThresholds = ALL_MAX_PURCHASE_THRESHOLDS): MaxPurchaseBoundaryValidation {
  const area = positive(input.areaM2);
  const resalePerM2 = effectiveResale(input, settings).base;
  const renovationMode = input.renovationMode ?? inferRenovationMode(input.condition);
  const perM2 = positive(input.renovationPerM2Override) ?? settings.renovationPerM2[renovationMode];
  if (area === null || resalePerM2 === null || maxPurchasePrice === null) return { status: "BLOCKED", checks: [{ code: "MAX_BUY_INPUTS_PRESENT", passed: false, detail: "Missing area, resale, renovation or max purchase price." }] };
  const renovation = multiplyMoneyByQuantity(moneyCents(perM2), area);
  const months = nonnegative(input.holdingMonthsOverride) ?? settings.holdingMonths;
  const finance = financeConfig(settings, months);
  const holding = multiplyMoneyByQuantity(finance.monthlyHoldingCost, months);
  const additional = moneyCents(nonnegative(input.additionalCostsOverride) ?? 0);
  const maxCents = moneyCents(maxPurchasePrice);
  const belowCents = Number(maxCents) > 0 ? (Number(maxCents) - 1) as MoneyCents : moneyCents(0);
  const aboveCents = (Number(maxCents) + 1) as MoneyCents;
  // Deliberately independent formula: do not call scenarioCents() or maxBuyCents().
  const below = independentValidatorScenario(belowCents, area, resalePerM2, renovation, holding, additional, finance);
  const above = independentValidatorScenario(aboveCents, area, resalePerM2, renovation, holding, additional, finance);
  const belowChecks = thresholdChecks(below, finance);
  const aboveChecks = thresholdChecks(above, finance);
  const belowPass = thresholdNames(thresholds).every((key) => belowChecks[key]);
  const grossExitCapFailed = BigInt(aboveCents) > BigInt(below.resaleValue ?? 0);
  const aboveFail = thresholdNames(thresholds).some((key) => !aboveChecks[key]) || grossExitCapFailed;
  const checks = [
    { code: "MAX_BUY_MINUS_ONE_PASSES", passed: belowPass, detail: `delta=-0.01 PLN;profit=${publicMoney(below.profit)};margin=${ratioCents(below.profit, below.resaleValue)};roi=${ratioCents(below.profit, below.totalProjectCost)}` },
    { code: "MAX_BUY_PLUS_ONE_FAILS", passed: aboveFail, detail: `delta=+0.01 PLN;profit=${publicMoney(above.profit)};margin=${ratioCents(above.profit, above.resaleValue)};roi=${ratioCents(above.profit, above.totalProjectCost)};grossExitCap=${grossExitCapFailed}` },
  ];
  return { status: checks.every((check) => check.passed) ? "PASS" : "FAIL", checks };
}

function financeConfig(settings: UnderwritingSettings, holdingMonths = settings.holdingMonths): FinanceConfig {
  return { fixedPurchaseCosts: moneyCents(settings.fixedPurchaseCosts), monthlyHoldingCost: moneyCents(settings.monthlyHoldingCost), contingencyRate: percentToBasisPoints(settings.contingencyPercent), purchaseTaxRate: percentToBasisPoints(settings.purchaseTaxPercent), purchaseCommissionRate: percentToBasisPoints(settings.purchaseCommissionPercent), financingLoanRate: percentToBasisPoints(settings.financingLoanPercent), financingAnnualRate: percentToBasisPoints(settings.financingAnnualRatePercent), salesRate: percentToBasisPoints(settings.salesCostPercent), minimumProfit: moneyCents(settings.minimumProfitPLN), minimumMargin: percentToBasisPoints(settings.minimumMarginPercent), minimumROI: percentToBasisPoints(settings.minimumROI), targetBuffer: percentToBasisPoints(settings.targetNegotiationBufferPercent), holdingMonths, financingEnabled: settings.financingEnabled };
}

function financingCostsCents(purchase: MoneyCents, finance: FinanceConfig, months: number): MoneyCents {
  if (!finance.financingEnabled) return moneyCents(0);
  const monthScale = BigInt(1_000);
  const monthCount = BigInt(Math.round(months * Number(monthScale)));
  return multiplyByFraction(purchase, BigInt(finance.financingLoanRate) * BigInt(finance.financingAnnualRate) * monthCount, BigInt(10_000) * BigInt(10_000) * BigInt(12) * monthScale);
}

function effectiveResale(input: UnderwritingInput, settings: UnderwritingSettings): { low: MoneyCents | null; base: MoneyCents | null; high: MoneyCents | null; provenance: ValueProvenance; confidence: number } {
  const override = positive(input.resalePerM2Override);
  if (override !== null) { const cents = moneyCents(override); return { low: multiplyByFraction(cents, BigInt(95), BigInt(100)), base: cents, high: multiplyByFraction(cents, BigInt(105), BigInt(100)), provenance: "USER_ASSUMPTION", confidence: 65 }; }
  const supplied = input.resalePerM2;
  if (positive(supplied?.base ?? null) !== null) return { low: moneyCents(positive(supplied?.low ?? null) ?? supplied!.base!), base: moneyCents(supplied!.base!), high: moneyCents(positive(supplied?.high ?? null) ?? supplied!.base!), provenance: supplied!.provenance, confidence: clamp(supplied!.confidence, 0, 100) };
  const market = settings.marketResalePerM2;
  if (positive(market.base) !== null) return { low: moneyCents(market.low), base: moneyCents(market.base), high: moneyCents(market.high), provenance: settings.marketResaleProvenance, confidence: settings.marketResaleProvenance === "USER_ASSUMPTION" ? 55 : 35 };
  return { low: null, base: null, high: null, provenance: "UNKNOWN", confidence: 0 };
}

function decide(input: UnderwritingInput, asking: MoneyCents | null, max: MoneyCents | null, scenario: InternalScenario, confidenceScore: number, missing: string[], finance: FinanceConfig): UnderwritingDecision {
  if (input.manualDecision === "REJECTED" || input.decisionBucket === "REJECTED" || ["REJECTED", "ARCHIVED", "STALE"].includes(input.lifecycleStatus ?? "")) return "REJECT";
  const profit = scenario.profit;
  if (profit === null || asking === null || max === null) return "REVIEW";
  if (asking > max) return "TOO_EXPENSIVE";
  const criticalMissing = missing.some((field) => ["area", "price", "location", "resale", "buildingType", "ownership"].includes(field));
  if (criticalMissing && input.manualDecision !== "ACCEPTED") return "REVIEW";
  const passes = passesThresholds(scenario, finance, ALL_MAX_PURCHASE_THRESHOLDS);
  if (!passes) return "TOO_EXPENSIVE";
  return confidenceScore >= 75 && BigInt(profit) * BigInt(2) >= BigInt(finance.minimumProfit) * BigInt(3) ? "HOT" : "GOOD";
}

function score(args: { input: UnderwritingInput; sourcePriceCents: MoneyCents | null; maxPurchaseCents: MoneyCents | null; profitCents: MoneyCents | null; marginBase: number | null; roiBase: number | null; confidenceScore: number }): { total: number; components: Array<{ label: string; points: number }> } {
  const economics = args.profitCents === null ? 0 : clamp(Math.round(Number(args.profitCents) / 500_000), -10, 25);
  const margin = args.marginBase === null ? 0 : clamp(Math.round(args.marginBase), -10, 20);
  const roi = args.roiBase === null ? 0 : clamp(Math.round(args.roiBase * 0.8), -10, 20);
  const purchase = args.sourcePriceCents !== null && args.maxPurchaseCents !== null ? (args.sourcePriceCents <= args.maxPurchaseCents ? 15 : clamp(Math.round(15 - Number(subtractMoney(args.sourcePriceCents, args.maxPurchaseCents)) / 500_000), -10, 14)) : 0;
  const liquidity = (positive(args.input.areaM2) !== null && args.input.areaM2! >= 25 && args.input.areaM2! <= 70 ? 6 : 2) + (positive(args.input.rooms) !== null && args.input.rooms! <= 4 ? 4 : 1);
  const evidence = Math.round(args.confidenceScore * 0.1);
  const components = [{ label: "Ekonomia", points: economics }, { label: "Marża", points: margin }, { label: "ROI", points: roi }, { label: "Cena zakupu", points: purchase }, { label: "Płynność", points: liquidity }, { label: "Jakość danych", points: evidence }];
  return { total: clamp(30 + components.reduce((sum, item) => sum + item.points, 0), 0, 100), components };
}

function confidence(input: UnderwritingInput, resaleConfidence: number, missing: string[]): number {
  let points = 10; // exact listing membership/provenance is a prerequisite upstream
  if (positive(input.askingPrice) !== null) points += 15;
  if (positive(input.areaM2) !== null) points += 15;
  if (positive(input.rooms) !== null) points += 8;
  if (input.city) points += 10;
  if (input.district || input.street) points += 5;
  if (input.buildingType) points += 8;
  if (input.condition) points += 6;
  if (input.ownership) points += 5;
  if (input.galleryAvailable) points += 3;
  points += Math.round(resaleConfidence * 0.1);
  return clamp(points - Math.max(0, missing.length - 3), 0, 100);
}

function collectMissing(input: UnderwritingInput, resale: number | null): string[] {
  const fields = new Set(input.missingFields ?? []);
  if (positive(input.askingPrice) === null) fields.add("price");
  if (positive(input.areaM2) === null) fields.add("area");
  if (positive(input.rooms) === null) fields.add("rooms");
  if (!input.city) fields.add("location");
  if (!input.buildingType) fields.add("buildingType");
  if (!input.ownership) fields.add("ownership");
  if (resale === null) fields.add("resale");
  return [...fields];
}

function redFlags(input: UnderwritingInput, max: MoneyCents | null, asking: MoneyCents | null, profit: MoneyCents | null, resaleConfidence: number): string[] {
  const flags: string[] = [];
  if (asking !== null && max !== null && asking > max) flags.push(`Cena ofertowa przekracza maksimum o ${moneyToPLN(subtractMoney(asking, max))} zł`);
  if (profit !== null && profit < 0) flags.push("Ujemny zysk w scenariuszu bazowym");
  if (!input.buildingType) flags.push("Niezweryfikowany typ budynku");
  if (!input.ownership) flags.push("Brak informacji o własności");
  if (resaleConfidence < 50) flags.push("Niska pewność ceny odsprzedaży");
  return flags;
}

function strengths(input: UnderwritingInput, profit: MoneyCents | null, margin: number | null, roi: number | null, max: MoneyCents | null, asking: MoneyCents | null): string[] {
  const values: string[] = [];
  if (profit !== null && profit >= moneyCents(50_000)) values.push("Zysk bazowy co najmniej 50 000 zł");
  if (margin !== null && margin >= 12) values.push("Marża bazowa co najmniej 12%");
  if (roi !== null && roi >= 12) values.push("ROI bazowe co najmniej 12%");
  if (asking !== null && max !== null && asking <= max) values.push("Cena mieści się w maksymalnej cenie zakupu");
  if (input.city && positive(input.areaM2) !== null && positive(input.rooms) !== null) values.push("Kluczowe dane nieruchomości są znane");
  return values;
}

function inferRenovationMode(condition: string | null): RenovationMode { return condition && /general|do remontu|wymaga remontu/i.test(condition) ? "FULL" : condition && /odświe|częściow/i.test(condition) ? "LIGHT" : "STANDARD"; }
function positive(value: number | null | undefined): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }
function nonnegative(value: number | null | undefined): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
