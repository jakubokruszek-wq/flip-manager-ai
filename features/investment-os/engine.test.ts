import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UNDERWRITING_SETTINGS } from "../flip-finder/underwriting.ts";
import { buildCanonicalDeal, downstreamForChange, fingerprintsEqual } from "./engine.ts";
import type { BuildDealInput } from "./types.ts";

function input(overrides: Partial<BuildDealInput> = {}): BuildDealInput {
  return {
    dealId: "deal-1", now: "2026-09-12T10:00:00.000Z", overrides: {}, settings: DEFAULT_UNDERWRITING_SETTINGS,
    market: { id: "comps-1", matchedBy: "RESALE_COMPS", low: 9_500, base: 10_000, high: 10_500, confidence: 80, provenance: "DERIVED", compCount: 7 },
    listing: { id: "listing-1", source: "facebook", sourceUrl: "https://facebook.com/groups/1/posts/2", externalListingId: "2", lifecycleStatus: "ACTIVE", decisionBucket: "MATCHED", manualDecision: null, city: "Łódź", district: "Górna", street: "Testowa 1", areaM2: 45, rooms: 2, floor: "2", floorsTotal: "4", buildingType: "BLOCK", yearBuilt: 1978, ownership: "pełna własność", condition: "do remontu", monthlyFee: 600, askingPrice: 300_000, askingPricePerM2: null, galleryStatus: "FAILED", imageCount: 0, identityExact: true },
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
  assert.ok(["GOOD", "HOT"].includes(dropped.ceo.result!.decision));
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
});
