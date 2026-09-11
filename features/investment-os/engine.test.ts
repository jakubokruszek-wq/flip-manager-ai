import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UNDERWRITING_SETTINGS } from "../flip-finder/underwriting.ts";
import { buildCanonicalDeal, downstreamForChange, fingerprintsEqual } from "./engine.ts";
import type { BuildDealInput } from "./types.ts";

function input(overrides: Partial<BuildDealInput> = {}): BuildDealInput {
  return {
    dealId: "deal-1", now: "2026-09-12T10:00:00.000Z", overrides: {}, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: { id: "comps-1", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80, provenance: "DERIVED", compCount: 7, fallbackLevel: 0, fallbackReason: "DIRECT_COMPARABLE_SET", confidencePenalty: 0, observedAt: "2026-09-12T09:00:00.000Z", evidenceId: "resale-comps:1,2,3" },
    listing: { id: "listing-1", source: "facebook", sourceUrl: "https://facebook.com/groups/1/posts/2", externalListingId: "2", lifecycleStatus: "ACTIVE", decisionBucket: "MATCHED", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978, ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000, askingPricePerM2: null, galleryStatus: "FAILED", imageCount: 0, identityExact: true, observedAt: "2026-09-12T09:30:00.000Z", conflicts: [] },
    ...overrides,
  };
}

test("builds five structured directors and three deterministic scenarios", () => {
  const deal = buildCanonicalDeal(input());
  assert.equal(deal.scout.status, "COMPLETE");
  assert.equal(deal.verify.status, "COMPLETE");
  assert.equal(deal.market.status, "COMPLETE");
  assert.equal(deal.underwriting.status, "COMPLETE");
  assert.equal(deal.ceo.status, "COMPLETE");
  assert.ok(deal.underwriting.result);
  assert.ok(deal.underwriting.result.scenarios.conservative.resaleValue! < deal.underwriting.result.scenarios.base.resaleValue!);
  assert.ok(deal.underwriting.result.scenarios.base.resaleValue! < deal.underwriting.result.scenarios.optimistic.resaleValue!);
  assert.equal(deal.stage, "DECISION_READY");
  assert.equal(typeof deal.ceo.result?.investmentThesis, "string");
  assert.ok(deal.ceo.result?.conditionsToProceed.length);
  assert.ok(deal.playbook.sellerQuestions.length);
  assert.ok(deal.playbook.negotiationPlan.length);
  assert.ok(deal.market.predictions.some((item) => item.metric === "RESALE_VALUE"));
  assert.ok(deal.underwriting.predictions.some((item) => item.metric === "PROFIT"));
  for (const director of [deal.scout, deal.verify, deal.market, deal.underwriting, deal.ceo]) {
    assert.equal(typeof director.finding, "string");
    assert.ok(director.recommendation);
    assert.ok(Array.isArray(director.evidence));
    assert.ok(Array.isArray(director.whatWouldChangeMyMind));
  }
});

test("missing market evidence blocks market and prevents fake profit", () => {
  const deal = buildCanonicalDeal(input({ market: null }));
  assert.equal(deal.market.status, "BLOCKED");
  assert.deepEqual(deal.market.reasonCodes, ["RESALE_ASSUMPTION_MISSING"]);
  assert.equal(deal.underwriting.status, "BLOCKED");
  assert.equal(deal.underwriting.result, null);
  assert.equal(deal.ceo.result?.decision, "REVIEW");
});

test("manual reject has absolute priority and gallery failure does not block math", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, manualDecision: "REJECTED", lifecycleStatus: "REJECTED", galleryStatus: "FAILED" } }));
  assert.equal(deal.underwriting.status, "COMPLETE");
  assert.equal(deal.ceo.result?.decision, "REJECT");
  assert.equal(deal.ceo.result?.action, "ODRZUĆ");
});

test("unknown building type lowers verification confidence but is not a hard negative", () => {
  const base = input();
  const complete = buildCanonicalDeal(base);
  const unknown = buildCanonicalDeal(input({ listing: { ...base.listing, buildingType: null } }));
  assert.ok(unknown.verify.confidence < complete.verify.confidence);
  assert.ok(unknown.verify.result?.missingOptionalFields.includes("buildingType"));
  assert.notEqual(unknown.ceo.reasonCodes[0], "CEO_HARD_REJECT");
});

test("same input is idempotent and price drop recomputes underwriting and CEO", () => {
  const first = buildCanonicalDeal(input());
  const same = buildCanonicalDeal(input());
  assert.ok(fingerprintsEqual(first, same));
  assert.deepEqual(first.ceo.result, same.ceo.result);
  const base = input();
  const expensive = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: 350_000 } }));
  const dropped = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: 200_000 } }));
  assert.notEqual(expensive.underwriting.inputFingerprint, dropped.underwriting.inputFingerprint);
  assert.ok(["TOO_EXPENSIVE", "REVIEW"].includes(expensive.ceo.result!.decision));
  assert.ok(["GOOD", "REVIEW"].includes(dropped.ceo.result!.decision));
  assert.equal(fingerprintsEqual({ ...first, market: { ...first.market, version: 1 } }, same), false);
});

test("manual override changes effective fact without destroying source and reset restores it", () => {
  const changed = buildCanonicalDeal(input({ overrides: { askingPrice: 275_000 } }));
  assert.equal(changed.facts.askingPrice.sourceValue, 300_000);
  assert.equal(changed.facts.askingPrice.overrideValue, 275_000);
  assert.equal(changed.facts.askingPrice.effectiveValue, 275_000);
  assert.equal(changed.facts.askingPrice.provenance, "MANUAL_OVERRIDE");
  const reset = buildCanonicalDeal(input({ overrides: {} }));
  assert.equal(reset.facts.askingPrice.effectiveValue, 300_000);
});

test("dependency graph invalidates only required downstream directors", () => {
  assert.deepEqual(downstreamForChange(["buildingType"]), ["VERIFY", "MARKET", "UNDERWRITER", "CEO"]);
  assert.deepEqual(downstreamForChange(["galleryStatus"]), ["VERIFY", "CEO"]);
  assert.deepEqual(downstreamForChange(["MARKET_ASSUMPTION"]), ["MARKET", "UNDERWRITER", "CEO"]);
  assert.deepEqual(downstreamForChange(["UNDERWRITING_SETTINGS"]), ["UNDERWRITER", "CEO"]);
});

test("max buy boundary passes one PLN below and fails one PLN above", () => {
  const deal = buildCanonicalDeal(input());
  const max = deal.underwriting.result!.maxPurchasePrice!;
  const base = input();
  const below = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: max - 1 } })).underwriting.result!;
  const above = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: max + 1 } })).underwriting.result!;
  assert.ok(below.purchasePrice! <= below.maxPurchasePrice!);
  assert.ok(above.purchasePrice! > above.maxPurchasePrice!);
  assert.equal(deal.underwriting.validation.status, "PASS");
  assert.ok(deal.underwriting.validation.checks.every((check) => check.passed));
});

test("every fact is classified and carries identified evidence metadata", () => {
  const deal = buildCanonicalDeal(input());
  assert.equal(deal.facts.areaM2.classification, "FACT");
  assert.equal(deal.facts.askingPricePerM2.classification, "ESTIMATE");
  assert.match(deal.facts.areaM2.evidenceId!, /^listing:/);
  assert.equal(deal.facts.areaM2.observedAt, "2026-09-12T09:30:00.000Z");
});

test("material fact conflict blocks verify and all downstream calculations", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, conflicts: [{ field: "areaM2", values: [{ value: 44, source: "LISTING", observedAt: base.now, evidenceId: "a" }, { value: 48, source: "SNAPSHOT", observedAt: base.now, evidenceId: "b" }] }] } }));
  assert.equal(deal.verify.status, "BLOCKED");
  assert.deepEqual(deal.verify.result?.conflicts, ["FACT_CONFLICT:areaM2"]);
  assert.equal(deal.market.status, "BLOCKED");
  assert.equal(deal.underwriting.result, null);
  assert.notEqual(deal.ceo.result?.action, "KUP");
});

test("weak or stale market fallback is explicit and blocked", () => {
  const weak = buildCanonicalDeal(input({ market: { ...input().market!, fallbackLevel: 4, fallbackReason: "CITY_ONLY_FALLBACK", confidencePenalty: 20 } }));
  assert.equal(weak.market.status, "BLOCKED");
  assert.equal(weak.market.fallbackReason, "CITY_ONLY_FALLBACK");
  assert.ok(weak.market.validation.reasonCodes.includes("MARKET_FALLBACK_ALLOWED"));
  const stale = buildCanonicalDeal(input({ market: { ...input().market!, observedAt: "2025-01-01T00:00:00.000Z" } }));
  assert.equal(stale.market.status, "BLOCKED");
  assert.ok(stale.market.validation.reasonCodes.includes("MARKET_EVIDENCE_FRESH"));
});

test("high economics cannot become BUY while critical legal gate is unknown", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, askingPrice: 150_000 } }));
  assert.notEqual(deal.ceo.result?.action, "KUP");
  assert.equal(deal.ceo.result?.humanApprovalRequired, true);
  assert.equal(deal.ceo.result?.autonomousPurchaseAllowed, false);
  assert.equal(deal.ceo.result?.criticalGates.find((gate) => gate.fact === "legalStatus")?.passed, false);
  assert.equal(deal.ceo.validation.status, "PASS");
  assert.equal(deal.ceo.result?.redTeam.length, 7);
});

test("manual reject is a veto that score cannot reverse", () => {
  const base = input();
  const deal = buildCanonicalDeal(input({ listing: { ...base.listing, manualDecision: "REJECTED", lifecycleStatus: "REJECTED", askingPrice: 1 } }));
  assert.equal(deal.ceo.result?.decision, "REJECT");
  assert.equal(deal.ceo.vetoes[0]?.code, "HARD_REJECT_VETO");
});
