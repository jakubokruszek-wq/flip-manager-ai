export const UNDERWRITING_DECISIONS = ["HOT", "GOOD", "REVIEW", "TOO_EXPENSIVE", "REJECT"] as const;
export type UnderwritingDecision = (typeof UNDERWRITING_DECISIONS)[number];
export type ValueProvenance = "EXTRACTED" | "DERIVED" | "USER_ASSUMPTION" | "MARKET_ASSUMPTION" | "UNKNOWN";
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

/** All PLN arithmetic is rounded through integer grosze at every monetary boundary. */
export function calculateUnderwriting(input: UnderwritingInput, settings: UnderwritingSettings = DEFAULT_UNDERWRITING_SETTINGS): UnderwritingResult {
  const area = positive(input.areaM2);
  const sourcePrice = positive(input.askingPrice);
  const purchasePrice = positive(input.priceOverride) ?? sourcePrice;
  const renovationMode = input.renovationMode ?? inferRenovationMode(input.condition);
  const renovationPerM2 = positive(input.renovationPerM2Override) ?? settings.renovationPerM2[renovationMode];
  const holdingMonths = nonnegative(input.holdingMonthsOverride) ?? settings.holdingMonths;
  const additionalCosts = nonnegative(input.additionalCostsOverride) ?? 0;
  const resale = effectiveResale(input, settings);
  const renovationBase = area === null ? null : money(area * renovationPerM2);
  const conservativeRenovation = renovationBase === null ? null : money(renovationBase * 1.15);
  const optimisticRenovation = renovationBase === null ? null : money(renovationBase * 0.95);
  const holdingCosts = money(holdingMonths * settings.monthlyHoldingCost);
  const baseScenario = scenario(purchasePrice, area, resale.base, renovationBase, holdingMonths, holdingCosts, additionalCosts, settings);
  const conservative = scenario(purchasePrice, area, resale.low, conservativeRenovation, holdingMonths, holdingCosts, additionalCosts, settings);
  const optimistic = scenario(purchasePrice, area, resale.high, optimisticRenovation, holdingMonths, holdingCosts, additionalCosts, settings);
  const maxPurchasePrice = maxBuy(area, resale.base, renovationBase, holdingMonths, holdingCosts, additionalCosts, settings);
  const targetPurchasePrice = maxPurchasePrice === null ? null : money(maxPurchasePrice * (1 - pct(settings.targetNegotiationBufferPercent)));
  const discountNeeded = sourcePrice !== null && targetPurchasePrice !== null ? money(Math.max(0, sourcePrice - targetPurchasePrice)) : null;
  const discountNeededPercent = discountNeeded !== null && sourcePrice !== null ? ratio(discountNeeded, sourcePrice) : null;
  const marginBase = baseScenario.profit !== null && baseScenario.resaleValue !== null ? ratio(baseScenario.profit, baseScenario.resaleValue) : null;
  const roiBase = baseScenario.profit !== null && baseScenario.totalProjectCost !== null ? ratio(baseScenario.profit, baseScenario.totalProjectCost) : null;
  const missingFields = collectMissing(input, resale.base);
  const confidenceScore = confidence(input, resale.confidence, missingFields);
  const scored = score({ input, sourcePrice, maxPurchasePrice, baseScenario, marginBase, roiBase, confidenceScore });
  const decision = decide(input, sourcePrice, maxPurchasePrice, baseScenario.profit, marginBase, roiBase, confidenceScore, missingFields, settings);
  const purchaseCosts = purchasePrice === null ? null : purchaseCostsFor(purchasePrice, settings);
  const financingCosts = purchasePrice === null ? null : financingFor(purchasePrice, holdingMonths, settings);
  const contingency = renovationBase === null ? null : money(renovationBase * pct(settings.contingencyPercent));
  const salesCosts = baseScenario.resaleValue === null ? null : money(baseScenario.resaleValue * pct(settings.salesCostPercent));
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
    askingPricePerM2: positive(input.askingPricePerM2) ?? (sourcePrice !== null && area !== null ? money(sourcePrice / area) : null),
    renovationMode,
    renovationPerM2,
    renovationTotal: renovationBase,
    purchaseTransactionCosts: purchaseCosts,
    holdingCosts,
    financingCosts,
    salesCosts,
    contingency,
    totalProjectCost: baseScenario.totalProjectCost,
    scenarios: { conservative, base: baseScenario, optimistic },
    profitLow: conservative.profit,
    profitBase: baseScenario.profit,
    profitHigh: optimistic.profit,
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
    redFlags: redFlags(input, maxPurchasePrice, sourcePrice, baseScenario.profit, resale.confidence),
    strengths: strengths(input, baseScenario.profit, marginBase, roiBase, maxPurchasePrice, sourcePrice),
    missingFields,
    resaleConfidence: resale.confidence,
  };
}

function scenario(purchase: number | null, area: number | null, resalePerM2: number | null, renovation: number | null, holdingMonths: number, holding: number, additional: number, settings: UnderwritingSettings): UnderwritingScenario {
  const resaleValue = area !== null && resalePerM2 !== null ? money(area * resalePerM2) : null;
  if (purchase === null || resaleValue === null || renovation === null) return { resalePerM2, resaleValue, renovationTotal: renovation, totalProjectCost: null, profit: null };
  const contingency = money(renovation * pct(settings.contingencyPercent));
  const total = money(purchase + purchaseCostsFor(purchase, settings) + financingFor(purchase, holdingMonths, settings) + renovation + contingency + holding + additional + resaleValue * pct(settings.salesCostPercent));
  return { resalePerM2, resaleValue, renovationTotal: renovation, totalProjectCost: total, profit: money(resaleValue - total) };
}

function maxBuy(area: number | null, resalePerM2: number | null, renovation: number | null, holdingMonths: number, holding: number, additional: number, settings: UnderwritingSettings): number | null {
  if (area === null || resalePerM2 === null || renovation === null) return null;
  const resale = money(area * resalePerM2);
  const requiredProfit = Math.max(settings.minimumProfitPLN, resale * pct(settings.minimumMarginPercent));
  const fixed = settings.fixedPurchaseCosts + renovation + renovation * pct(settings.contingencyPercent) + holding + additional + resale * pct(settings.salesCostPercent);
  const purchaseFactor = 1 + pct(settings.purchaseTaxPercent + settings.purchaseCommissionPercent) + (settings.financingEnabled ? pct(settings.financingLoanPercent) * pct(settings.financingAnnualRatePercent) * holdingMonths / 12 : 0);
  return money(Math.max(0, (resale - requiredProfit - fixed) / purchaseFactor));
}

function purchaseCostsFor(purchase: number, settings: UnderwritingSettings): number { return money(settings.fixedPurchaseCosts + purchase * pct(settings.purchaseTaxPercent + settings.purchaseCommissionPercent)); }
function financingFor(purchase: number, months: number, settings: UnderwritingSettings): number { return settings.financingEnabled ? money(purchase * pct(settings.financingLoanPercent) * pct(settings.financingAnnualRatePercent) * months / 12) : 0; }

function effectiveResale(input: UnderwritingInput, settings: UnderwritingSettings): { low: number | null; base: number | null; high: number | null; provenance: ValueProvenance; confidence: number } {
  const override = positive(input.resalePerM2Override);
  if (override !== null) return { low: money(override * 0.95), base: override, high: money(override * 1.05), provenance: "USER_ASSUMPTION", confidence: 65 };
  const supplied = input.resalePerM2;
  if (positive(supplied?.base ?? null) !== null) return { low: positive(supplied?.low ?? null) ?? supplied!.base!, base: supplied!.base, high: positive(supplied?.high ?? null) ?? supplied!.base!, provenance: supplied!.provenance, confidence: clamp(supplied!.confidence, 0, 100) };
  const market = settings.marketResalePerM2;
  if (positive(market.base) !== null) return { ...market, provenance: settings.marketResaleProvenance, confidence: settings.marketResaleProvenance === "USER_ASSUMPTION" ? 55 : 35 };
  return { low: null, base: null, high: null, provenance: "UNKNOWN", confidence: 0 };
}

function decide(input: UnderwritingInput, asking: number | null, max: number | null, profit: number | null, margin: number | null, roi: number | null, confidenceScore: number, missing: string[], settings: UnderwritingSettings): UnderwritingDecision {
  if (input.manualDecision === "REJECTED" || input.decisionBucket === "REJECTED" || ["REJECTED", "ARCHIVED", "STALE"].includes(input.lifecycleStatus ?? "")) return "REJECT";
  if (profit === null || asking === null || max === null) return "REVIEW";
  if (asking > max) return "TOO_EXPENSIVE";
  const criticalMissing = missing.some((field) => ["area", "price", "location", "resale", "buildingType", "ownership"].includes(field));
  if (criticalMissing && input.manualDecision !== "ACCEPTED") return "REVIEW";
  const passes = profit >= settings.minimumProfitPLN && (margin ?? -Infinity) >= settings.minimumMarginPercent && (roi ?? -Infinity) >= settings.minimumROI;
  if (!passes) return "TOO_EXPENSIVE";
  return confidenceScore >= 75 && profit >= settings.minimumProfitPLN * 1.5 ? "HOT" : "GOOD";
}

function score(args: { input: UnderwritingInput; sourcePrice: number | null; maxPurchasePrice: number | null; baseScenario: UnderwritingScenario; marginBase: number | null; roiBase: number | null; confidenceScore: number }): { total: number; components: Array<{ label: string; points: number }> } {
  const economics = args.baseScenario.profit === null ? 0 : clamp(Math.round(args.baseScenario.profit / 5_000), -10, 25);
  const margin = args.marginBase === null ? 0 : clamp(Math.round(args.marginBase), -10, 20);
  const roi = args.roiBase === null ? 0 : clamp(Math.round(args.roiBase * 0.8), -10, 20);
  const purchase = args.sourcePrice !== null && args.maxPurchasePrice !== null ? (args.sourcePrice <= args.maxPurchasePrice ? 15 : clamp(Math.round(15 - (args.sourcePrice - args.maxPurchasePrice) / 5_000), -10, 14)) : 0;
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

function redFlags(input: UnderwritingInput, max: number | null, asking: number | null, profit: number | null, resaleConfidence: number): string[] {
  const flags: string[] = [];
  if (asking !== null && max !== null && asking > max) flags.push(`Cena ofertowa przekracza maksimum o ${money(asking - max)} zł`);
  if (profit !== null && profit < 0) flags.push("Ujemny zysk w scenariuszu bazowym");
  if (!input.buildingType) flags.push("Niezweryfikowany typ budynku");
  if (!input.ownership) flags.push("Brak informacji o własności");
  if (resaleConfidence < 50) flags.push("Niska pewność ceny odsprzedaży");
  return flags;
}

function strengths(input: UnderwritingInput, profit: number | null, margin: number | null, roi: number | null, max: number | null, asking: number | null): string[] {
  const values: string[] = [];
  if (profit !== null && profit >= 50_000) values.push("Zysk bazowy co najmniej 50 000 zł");
  if (margin !== null && margin >= 12) values.push("Marża bazowa co najmniej 12%");
  if (roi !== null && roi >= 12) values.push("ROI bazowe co najmniej 12%");
  if (asking !== null && max !== null && asking <= max) values.push("Cena mieści się w maksymalnej cenie zakupu");
  if (input.city && positive(input.areaM2) !== null && positive(input.rooms) !== null) values.push("Kluczowe dane nieruchomości są znane");
  return values;
}

function inferRenovationMode(condition: string | null): RenovationMode { return condition && /general|do remontu|wymaga remontu/i.test(condition) ? "FULL" : condition && /odświe|częściow/i.test(condition) ? "LIGHT" : "STANDARD"; }
function money(value: number): number { return Math.round(Math.round(value * 100)) / 100; }
function ratio(value: number, base: number): number { return base > 0 ? Math.round(value / base * 10_000) / 100 : 0; }
function pct(value: number): number { return clamp(value, 0, 100) / 100; }
function positive(value: number | null | undefined): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }
function nonnegative(value: number | null | undefined): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
