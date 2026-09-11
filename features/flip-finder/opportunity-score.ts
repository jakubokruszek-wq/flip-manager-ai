import type { SearchFilter } from "./index.ts";
import { evaluateListingAgainstFilter } from "./filter-evaluation.ts";
import { ANALYSIS_RULES, renovationScope } from "../ai-analysis/rules.ts";
import { calculateResaleArv, selectResaleComps, type ResaleArv } from "../market-intelligence/resale-arv.ts";
import type { ResaleCompRecord } from "../market-intelligence/resale-comps.ts";
import { calculateUnderwriting, type UnderwritingResult } from "./underwriting.ts";

export const OPPORTUNITY_PRIORITIES = ["TOP", "HIGH", "MEDIUM", "LOW"] as const;
export type OpportunityPriority = (typeof OPPORTUNITY_PRIORITIES)[number];
export type OpportunityConfidence = "HIGH" | "MEDIUM" | "LOW";

/**
 * Explicit, configurable business guardrails for priority buckets.  The
 * opportunity score remains relative; these values prevent a weak absolute
 * deal from being presented as a high-priority opportunity merely because it
 * is the best item in a small sample.
 */
export const OPPORTUNITY_QUALITY_GUARDS = {
  minimumHighRoiPct: 10,
  minimumHighProfit: 0,
  minimumHighMarketDiscountPct: 0,
} as const;

export type OpportunityListingInput = {
  id: string;
  source: string;
  sourceUrl?: string;
  lifecycleStatus?: string | null;
  decisionBucket?: "MATCHED" | "REVIEW" | "REJECTED";
  manualDecision?: "ACCEPTED" | "REJECTED" | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  pricePerSqm: number | null;
  city: string | null;
  district: string | null;
  address: string | null;
  buildingType: string | null;
  ownership?: string | null;
  totalFloors?: string | null;
  galleryAvailable?: boolean;
  floor: string | null;
  title: string | null;
  description: string | null;
  missingFields: string[];
  lastSeenAt: string | null;
};

export type OpportunityAssessment = {
  score: number;
  priority: OpportunityPriority;
  economicsConfidence: OpportunityConfidence;
  arvConfidence: OpportunityConfidence;
  dataConfidence: OpportunityConfidence;
  compCount: number;
  conservativeArv: number | null;
  expectedArv: number | null;
  optimisticArv: number | null;
  grossSpread: number | null;
  estimatedRenovationCost: number | null;
  estimatedProfit: number | null;
  estimatedRoi: number | null;
  marketDiscountPct: number | null;
  missingFields: string[];
  calculatedAt: string;
  underwriting: UnderwritingResult;
};

/**
 * Scores only records that are allowed to be shown to a user.  Lifecycle and
 * hard-decision checks intentionally happen before any economics are read, so
 * an attractive ARV can never resurrect an archived or rejected listing.
 */
export function calculateOpportunityAssessment(
  input: OpportunityListingInput,
  filter: SearchFilter,
  comps: ResaleCompRecord[] = [],
  now = Date.now(),
): OpportunityAssessment | null {
  if (!isScorable(input) || hasHardFilterViolation(input, filter)) return null;

  const subject = {
    id: input.id,
    area: positive(input.area),
    rooms: positive(input.rooms),
    city: input.city,
    district: input.district,
    address: input.address,
    buildingType: input.buildingType,
    floor: input.floor,
  };
  const comparables = selectResaleComps(subject, comps, now);
  const arv = calculateResaleArv(subject, comparables);
  const price = positive(input.price);
  const area = positive(input.area);
  const pricePerSqm = positive(input.pricePerSqm) ?? (price !== null && area !== null ? price / area : null);
  const expectedPerSqm = arv.weightedPricePerSqm ?? arv.medianPricePerSqm;
  const marketDiscountPct = pricePerSqm !== null && expectedPerSqm !== null && expectedPerSqm > 0
    ? ((expectedPerSqm - pricePerSqm) / expectedPerSqm) * 100
    : null;
  const renovationCost = area === null ? null : renovationEstimate(area, input.title, input.description);
  const estimatedProfit = estimateProfit(price, arv.expectedPrice, renovationCost);
  const estimatedRoi = estimateRoi(price, renovationCost, estimatedProfit);
  const arvConfidence = confidenceForArv(comparables, arv);
  const dataConfidence = confidenceForData(input, pricePerSqm);
  const economicsConfidence = confidenceForEconomics({
    estimatedProfit,
    estimatedRoi,
    marketDiscountPct,
    arvConfidence,
  });
  const underwriting = calculateUnderwriting({
    listingId: input.id,
    source: input.source,
    sourceUrl: input.sourceUrl ?? "",
    lifecycleStatus: input.lifecycleStatus ?? null,
    decisionBucket: input.decisionBucket ?? "REVIEW",
    manualDecision: input.manualDecision ?? null,
    city: input.city,
    district: input.district,
    street: input.address,
    areaM2: input.area,
    rooms: input.rooms,
    floor: input.floor,
    floorsTotal: input.totalFloors ?? null,
    buildingType: input.buildingType,
    yearBuilt: null,
    ownership: input.ownership ?? null,
    condition: `${input.title ?? ""} ${input.description ?? ""}`,
    monthlyFee: null,
    askingPrice: input.price,
    askingPricePerM2: pricePerSqm,
    resalePerM2: {
      low: area && arv.conservativePrice ? arv.conservativePrice / area : null,
      base: area && arv.expectedPrice ? arv.expectedPrice / area : null,
      high: area && arv.optimisticPrice ? arv.optimisticPrice / area : null,
      provenance: "DERIVED",
      confidence: arvConfidence === "HIGH" ? 90 : arvConfidence === "MEDIUM" ? 65 : 0,
    },
    missingFields: input.missingFields,
    galleryAvailable: input.galleryAvailable ?? false,
  });

  return {
    score: underwriting.flipScore,
    priority: priorityForBusiness(underwriting.flipScore, {
      estimatedProfit: underwriting.profitBase,
      estimatedRoi: underwriting.roiBase,
      marketDiscountPct,
      arvConfidence,
    }),
    economicsConfidence,
    arvConfidence,
    dataConfidence,
    compCount: comparables.length,
    conservativeArv: arv.conservativePrice,
    expectedArv: arv.expectedPrice,
    optimisticArv: arv.optimisticPrice,
    grossSpread: arv.expectedPrice !== null && price !== null ? arv.expectedPrice - price : null,
    estimatedRenovationCost: underwriting.renovationTotal,
    estimatedProfit: underwriting.profitBase,
    estimatedRoi: underwriting.roiBase,
    marketDiscountPct,
    missingFields: missingFields(input),
    calculatedAt: new Date(now).toISOString(),
    underwriting,
  };
}

export function priorityFor(score: number): OpportunityPriority {
  if (score >= 80) return "TOP";
  if (score >= 65) return "HIGH";
  if (score >= 45) return "MEDIUM";
  return "LOW";
}

type EconomicsSnapshot = {
  estimatedProfit: number | null;
  estimatedRoi: number | null;
  marketDiscountPct: number | null;
  arvConfidence: OpportunityConfidence;
};

/**
 * Applies absolute economics after calculating the relative score.  Missing
 * values do not become an automatic hard reject, but they cannot claim a TOP
 * or HIGH bucket without enough evidence.
 */
export function priorityForBusiness(score: number, economics: EconomicsSnapshot): OpportunityPriority {
  const relative = priorityFor(score);

  if (
    economics.estimatedProfit !== null &&
    economics.estimatedProfit <= OPPORTUNITY_QUALITY_GUARDS.minimumHighProfit
  ) {
    return "LOW";
  }

  if (
    economics.estimatedRoi === null ||
    economics.estimatedRoi < OPPORTUNITY_QUALITY_GUARDS.minimumHighRoiPct ||
    economics.arvConfidence === "LOW" ||
    economics.marketDiscountPct === null ||
    economics.marketDiscountPct <= OPPORTUNITY_QUALITY_GUARDS.minimumHighMarketDiscountPct
  ) {
    return relative === "TOP" || relative === "HIGH" ? "MEDIUM" : relative;
  }

  return relative;
}

export function priorityLabel(priority: OpportunityPriority): string {
  return priority === "TOP" ? "PILNE / TOP" : priority === "HIGH" ? "WYSOKI POTENCJAŁ" : priority === "MEDIUM" ? "DO OCENY" : "NISKI PRIORYTET";
}

function isScorable(input: OpportunityListingInput): boolean {
  if (input.manualDecision === "REJECTED") return false;
  if (["STALE", "ARCHIVED", "REJECTED"].includes(input.lifecycleStatus ?? "")) return false;
  if (input.decisionBucket === "REJECTED") return false;
  return input.lifecycleStatus === "ACTIVE" || input.lifecycleStatus === "REVIEW" || input.decisionBucket === "MATCHED" || input.decisionBucket === "REVIEW";
}

function hasHardFilterViolation(input: OpportunityListingInput, filter: SearchFilter): boolean {
  if (filter.sources.length > 0 && !filter.sources.includes(input.source as SearchFilter["sources"][number])) return true;
  const decision = evaluateListingAgainstFilter({
    price: input.price,
    area: input.area,
    pricePerSqm: input.pricePerSqm,
    rooms: input.rooms,
    floor: input.floor,
    city: input.city,
    district: input.district,
    title: input.title,
    locationText: input.address,
    buildingType: input.buildingType,
    ownership: null,
    sellerType: null,
    marketType: null,
  }, filter);
  return decision.bucket === "REJECTED";
}

export function scoreOpportunity(input: {
  input: OpportunityListingInput;
  filter: SearchFilter;
  price: number | null;
  area: number | null;
  pricePerSqm: number | null;
  marketDiscountPct: number | null;
  estimatedProfit: number | null;
  arvConfidence: OpportunityConfidence;
  dataConfidence: OpportunityConfidence;
  comparables: Array<{ similarityScore: number; freshnessDays?: number | null }>;
}): number {
  // Weights reflect the decision order: economics first, then evidence quality
  // and fit. Missing secondary fields reduce confidence, not the opportunity.
  const market = input.marketDiscountPct === null ? 8 : clamp(10 + input.marketDiscountPct * 0.5, 0, 25);
  const profit = input.estimatedProfit === null ? 8 : clamp(8 + input.estimatedProfit / 4_000, 0, 25);
  const evidence = input.arvConfidence === "HIGH" ? 15 : input.arvConfidence === "MEDIUM" ? 10 : 4;
  const comparableSimilarity = input.comparables.length
    ? clamp(input.comparables.reduce((sum, item) => sum + item.similarityScore, 0) / input.comparables.length / 10, 0, 8)
    : 0;
  const freshness = input.comparables.length && input.comparables.some((item) => (item.freshnessDays ?? Infinity) <= 60) ? 2 : 0;
  const data = input.dataConfidence === "HIGH" ? 10 : input.dataConfidence === "MEDIUM" ? 8 : 6;
  const location = input.input.address ? 5 : input.input.district ? 4 : input.input.city ? 3 : 0;
  const fit = filterFit(input.input, input.filter, input.price, input.area, input.pricePerSqm);
  return Math.round(clamp(market + profit + evidence + comparableSimilarity + freshness + data + location + fit, 0, 100));
}

function filterFit(input: OpportunityListingInput, filter: SearchFilter, price: number | null, area: number | null, pricePerSqm: number | null): number {
  let score = 0;
  if (filter.city && input.city && normalize(input.city) === normalize(filter.city)) score += 4;
  else if (input.city) score += 2;
  if (filter.rooms.length === 0 || input.rooms === null || filter.rooms.includes(input.rooms)) score += 2;
  if (filter.areaMin === null && filter.areaMax === null) score += 2;
  else if (area !== null && (filter.areaMin === null || area >= filter.areaMin) && (filter.areaMax === null || area <= filter.areaMax)) score += 2;
  if (filter.maxPricePerSqm === null || pricePerSqm === null || pricePerSqm <= filter.maxPricePerSqm) score += 2;
  if (filter.priceMin === null || price === null || price >= filter.priceMin) score += 1;
  if (filter.priceMax === null || price === null || price <= filter.priceMax) score += 1;
  return Math.min(10, score);
}

function confidenceForArv(comparables: Array<{ similarityScore: number; freshnessDays?: number | null }>, arv: ResaleArv): OpportunityConfidence {
  if (arv.compCount >= 5 && comparables.length > 0) {
    const similarity = comparables.reduce((sum, item) => sum + item.similarityScore, 0) / comparables.length;
    const fresh = comparables.filter((item) => (item.freshnessDays ?? Infinity) <= 90).length >= 3;
    if (similarity >= 65 && fresh) return "HIGH";
  }
  if (arv.compCount >= 2) return "MEDIUM";
  return "LOW";
}

function confidenceForData(input: OpportunityListingInput, pricePerSqm: number | null): OpportunityConfidence {
  const keyFields = [input.price, input.area, input.rooms, input.city, pricePerSqm].filter((value) => value !== null).length;
  return keyFields >= 5 ? "HIGH" : keyFields >= 3 ? "MEDIUM" : "LOW";
}

function confidenceForEconomics(input: EconomicsSnapshot): OpportunityConfidence {
  if (
    input.estimatedProfit === null ||
    input.estimatedRoi === null ||
    input.estimatedProfit <= 0 ||
    input.estimatedRoi < 0
  ) {
    return "LOW";
  }

  if (
    input.arvConfidence === "HIGH" &&
    input.estimatedRoi >= OPPORTUNITY_QUALITY_GUARDS.minimumHighRoiPct &&
    (input.marketDiscountPct ?? 0) > OPPORTUNITY_QUALITY_GUARDS.minimumHighMarketDiscountPct
  ) {
    return "HIGH";
  }

  return input.arvConfidence === "LOW" ? "LOW" : "MEDIUM";
}

function renovationEstimate(area: number, title: string | null, description: string | null): number {
  const rate = ANALYSIS_RULES.renovationPerSqm[renovationScope(title, description)];
  return Math.round(area * ((rate.min + rate.max) / 2));
}

function estimateProfit(price: number | null, arv: number | null, renovationCost: number | null): number | null {
  if (price === null || arv === null || renovationCost === null) return null;
  const purchaseCosts = price * 0.02;
  const sellingCosts = arv * 0.02;
  return Math.round(arv - sellingCosts - price - purchaseCosts - renovationCost);
}

function estimateRoi(price: number | null, renovationCost: number | null, profit: number | null): number | null {
  if (price === null || renovationCost === null || profit === null) return null;
  const invested = price * 1.02 + renovationCost;
  return invested > 0 ? Math.round((profit / invested) * 1000) / 10 : null;
}

function missingFields(input: OpportunityListingInput): string[] {
  const fields = new Set(input.missingFields);
  if (input.price === null) fields.add("price");
  if (input.area === null) fields.add("area");
  if (input.rooms === null) fields.add("rooms");
  if (!input.address) fields.add("address");
  if (!input.buildingType) fields.add("buildingType");
  return [...fields];
}

function positive(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function priorityScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, priorityScore(value)));
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").trim();
}
