import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UNDERWRITING_SETTINGS } from "../../flip-finder/underwriting.ts";
import { buildCanonicalDeal } from "../engine.ts";
import type { BuildDealInput } from "../types.ts";
import { buildDealBrain } from "./index.ts";
import { BRAIN_DIRECTORS } from "./types.ts";

function input(overrides: Partial<BuildDealInput> = {}): BuildDealInput {
  return {
    dealId: "deal-1", now: "2026-09-12T10:00:00.000Z", overrides: {}, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: { id: "comps-1", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80, provenance: "DERIVED", compCount: 3, fallbackLevel: 0, fallbackReason: "DIRECT_COMPARABLE_SET", confidencePenalty: 0, observedAt: "2026-09-12T09:00:00.000Z", evidenceId: "resale-comps:1,2,3", priceEvidenceType: "ASKING", comparables: [1, 2, 3].map((index) => ({ id: `comp-${index}`, source: "OLX", sourceUrl: `https://example.test/${index}`, pricePerM2: 9_500 + index * 250, similarityScore: 80 - index, dataQuality: 85, freshnessDays: index * 5, distanceMeters: index * 200, adjustments: ["AREA_MATCH"], weight: .8 - index * .05, outlierReason: null, priceEvidenceType: "ASKING" as const })) },
    listing: { id: "listing-1", source: "facebook", sourceUrl: "https://facebook.com/groups/1/posts/2", externalListingId: "2", lifecycleStatus: "ACTIVE", decisionBucket: "MATCHED", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978, ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000, askingPricePerM2: null, galleryStatus: "FAILED", imageCount: 0, identityExact: true, observedAt: "2026-09-12T09:30:00.000Z", conflicts: [] },
    ...overrides,
  };
}

test("every mission director appears in the snapshot, in the declared order, with traceable generatedFrom metadata", () => {
  const deal = buildCanonicalDeal(input());
  const brain = buildDealBrain(deal);
  assert.deepEqual(brain.directorOrder, BRAIN_DIRECTORS);
  for (const id of BRAIN_DIRECTORS) {
    const director = brain.directors[id];
    assert.ok(director, `missing director ${id}`);
    assert.equal(director.generatedFrom.dealId, deal.id);
    assert.equal(director.generatedFrom.factsFingerprint, deal.factsFingerprint);
  }
  assert.equal(brain.directors.SCOUT.status, "READY");
  assert.equal(brain.directors.VERIFY.status, "READY");
  assert.equal(brain.directors.MARKET.status, "READY");
  assert.equal(brain.directors.UNDERWRITER.status, "READY");
});

test("the permanently unverified legal gate is surfaced as a blocking conflict, not fabricated as a defect", () => {
  const deal = buildCanonicalDeal(input());
  const brain = buildDealBrain(deal);
  const legal = brain.conflicts.find((risk) => risk.id === "legal-evidence-missing");
  assert.ok(legal);
  assert.equal(legal.severity, "BLOCKER");
  assert.ok(legal.directorsInvolved.includes("CEO"));
  assert.doesNotMatch(legal.explanation, /wada prawna zosta.a wykryta/i);
});

test("a material fact conflict blocks VERIFY and is reported as a dedicated conflict", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, conflicts: [{ field: "askingPrice", values: [{ value: 300_000, source: "facebook", observedAt: base.listing.observedAt, evidenceId: "e1" }, { value: 280_000, source: "olx", observedAt: base.listing.observedAt, evidenceId: "e2" }] }] } }));
  const brain = buildDealBrain(deal);
  assert.equal(deal.verify.status, "BLOCKED");
  assert.equal(brain.directors.VERIFY.status, "BLOCKED");
  assert.ok(brain.conflicts.some((risk) => risk.id === "material-fact-conflict"));
});

test("blocking MARKET input propagates to dependent directors and to CEO's decision", () => {
  const deal = buildCanonicalDeal(input({ market: null }));
  const brain = buildDealBrain(deal);
  assert.equal(brain.directors.MARKET.status, "BLOCKED");
  assert.notEqual(brain.directors.UNDERWRITER.status, "READY");
  assert.notEqual(brain.directors.SALE.status, "READY");
  assert.equal(brain.ceo.decision, "VERIFY");
  assert.ok(brain.ceo.blockingIssues.length > 0 || brain.ceo.conditionsToProceed.length > 0);
});

test("stale source facts propagate STALE freshness downstream and collapse CEO confidence", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, observedAt: "2026-01-01T00:00:00.000Z" } }));
  const brain = buildDealBrain(deal);
  assert.equal(brain.directors.VERIFY.freshness, "STALE");
  assert.equal(brain.directors.UNDERWRITER.freshness, "STALE");
  assert.equal(brain.freshness, "STALE");
  assert.equal(brain.ceo.confidenceState, "UNKNOWN");
  assert.equal(brain.ceo.decision, "VERIFY");
});

test("questions are deduplicated by field regardless of how many directors raised them", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, district: null, street: null, buildingType: null, ownership: null, condition: null, monthlyFee: null } }));
  const brain = buildDealBrain(deal);
  const fields = brain.questions.map((question) => question.field);
  assert.equal(new Set(fields).size, fields.length, "brain.questions must not contain duplicate fields");
  assert.ok(fields.length > 1);
});

test("questions are ordered by category then priority, most urgent first", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, district: null, street: null, buildingType: null, ownership: null, condition: null } }));
  const brain = buildDealBrain(deal);
  const categoryRank = { BLOCKING: 0, DECISION_CHANGING: 1, USEFUL: 2 } as const;
  const priorityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  for (let i = 1; i < brain.questions.length; i += 1) {
    const previous = brain.questions[i - 1], current = brain.questions[i];
    const previousRank = categoryRank[previous.category] * 10 + priorityRank[previous.priority];
    const currentRank = categoryRank[current.category] * 10 + priorityRank[current.priority];
    assert.ok(previousRank <= currentRank, `question ${i - 1} (${previous.field}) must not be less urgent than question ${i} (${current.field})`);
  }
  assert.deepEqual(brain.topQuestions, brain.questions.slice(0, 3));
});

test("CEO synthesis never invents a purchase authority and always names exactly one Next Best Action", () => {
  const deal = buildCanonicalDeal(input());
  const brain = buildDealBrain(deal);
  assert.equal(brain.ceo.humanApprovalRequired, true);
  assert.equal(brain.ceo.autonomousPurchaseAllowed, false);
  assert.equal(typeof brain.ceo.nextBestAction, "object");
  assert.ok(!Array.isArray(brain.ceo.nextBestAction));
  assert.equal(typeof brain.ceo.nextBestAction.title, "string");
  assert.ok(brain.ceo.nextBestAction.title.length > 0);
});

test("a manual hard reject is an absolute veto CEO synthesis cannot reverse", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, manualDecision: "REJECTED" } }));
  const brain = buildDealBrain(deal);
  assert.equal(brain.ceo.decision, "REJECT");
  assert.match(brain.ceo.nextBestAction.title, /odrzucen/i);
});

test("an overpriced deal routes to NEGOTIATE with the canonical opening offer, not a re-derived one", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: 900_000 } }));
  assert.equal(deal.underwriting.result?.decision, "TOO_EXPENSIVE");
  const brain = buildDealBrain(deal);
  assert.equal(brain.ceo.decision, "NEGOTIATE");
  if (deal.ceo.result?.openingOffer != null) {
    const formatted = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(deal.ceo.result.openingOffer);
    assert.match(brain.ceo.nextBestAction.title, /ofertę otwierającą/);
    assert.ok(brain.ceo.nextBestAction.title.includes(formatted), "next best action must quote the canonical opening offer verbatim");
  }
});

test("every UNDERWRITER metric provenance traces back to the canonical underwriting output, never a fabricated source", () => {
  const deal = buildCanonicalDeal(input());
  const brain = buildDealBrain(deal);
  const metrics = brain.directors.UNDERWRITER.metrics;
  assert.ok(metrics.length > 0);
  for (const metric of metrics) assert.match(metric.provenance.sourcePath, /^underwriting\.result\./);
});

test("financial invariants: brain never recomputes profit, ROI, Max Buy or the buy gate, only reads them", () => {
  const deal = buildCanonicalDeal(input());
  const brain = buildDealBrain(deal);
  const underwriting = deal.underwriting.result!;
  assert.equal(brain.financials?.profitBase, underwriting.profitBase);
  assert.equal(brain.financials?.profitLow, underwriting.profitLow);
  assert.equal(brain.financials?.profitHigh, underwriting.profitHigh);
  assert.equal(brain.financials?.roiBase, underwriting.roiBase);
  assert.equal(brain.financials?.maxPurchasePrice, underwriting.maxPurchasePrice);
  assert.equal(brain.financials?.targetPurchasePrice, underwriting.targetPurchasePrice);
  assert.equal(brain.financials?.scenarios, underwriting.scenarios);
  assert.equal(brain.financials?.buyGate, deal.ceo.result?.criticalGates);
});

test("financials are null, not fabricated, when underwriting never produced a result", () => {
  const deal = buildCanonicalDeal(input({ market: null }));
  const brain = buildDealBrain(deal);
  assert.equal(deal.underwriting.result, null);
  assert.equal(brain.financials, null);
});

test("building the brain twice from the same canonical deal is fully deterministic", () => {
  const deal = buildCanonicalDeal(input());
  const first = buildDealBrain(deal);
  const second = buildDealBrain(deal);
  assert.deepEqual(first, second);
});

test("building the brain is pure and does not mutate the canonical deal it reads", () => {
  const deal = buildCanonicalDeal(input());
  const before = JSON.stringify(deal);
  buildDealBrain(deal);
  assert.equal(JSON.stringify(deal), before);
});
