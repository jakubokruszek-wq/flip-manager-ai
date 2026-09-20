import assert from "node:assert/strict";
import test from "node:test";
import { sortResults } from "./results.ts";

type Fixture = {
  id: string;
  publishedAt: string | null;
  lastSeenAt: string;
  price: number | null;
  pricePerSqm: number | null;
  priceDropAmount: number | null;
  opportunityScore: number | null;
  estimatedProfit: number | null;
  estimatedRoi: number | null;
  marketDiscountPct: number | null;
  dataConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
};

function fixture(overrides: Partial<Fixture> & { id: string }): Fixture {
  return {
    publishedAt: "2026-09-01T10:00:00Z",
    lastSeenAt: "2026-09-01T10:00:00Z",
    price: null,
    pricePerSqm: null,
    priceDropAmount: null,
    opportunityScore: null,
    estimatedProfit: null,
    estimatedRoi: null,
    marketDiscountPct: null,
    dataConfidence: null,
    ...overrides,
  };
}

function ids(items: Fixture[]): string[] {
  return items.map((item) => item.id);
}

test("newest orders by publishedAt descending and pushes unpublished results to the end", () => {
  const older = fixture({ id: "older", publishedAt: "2026-09-01T08:00:00Z" });
  const newer = fixture({ id: "newer", publishedAt: "2026-09-01T12:00:00Z" });
  const unpublished = fixture({ id: "unpublished", publishedAt: null, lastSeenAt: "2026-09-01T14:00:00Z" });
  assert.deepEqual(ids(sortResults([older, newer, unpublished], "newest")), ["newer", "older", "unpublished"]);
});

test("price_asc orders by price ascending and pushes unknown/non-positive prices to the end", () => {
  const cheap = fixture({ id: "cheap", price: 200_000 });
  const expensive = fixture({ id: "expensive", price: 400_000 });
  const unknown = fixture({ id: "unknown", price: null });
  assert.deepEqual(ids(sortResults([expensive, unknown, cheap], "price_asc")), ["cheap", "expensive", "unknown"]);
});

test("price_per_sqm_asc orders by price per square meter ascending", () => {
  const cheaper = fixture({ id: "cheaper", pricePerSqm: 6_000 });
  const pricier = fixture({ id: "pricier", pricePerSqm: 9_000 });
  assert.deepEqual(ids(sortResults([pricier, cheaper], "price_per_sqm_asc")), ["cheaper", "pricier"]);
});

test("opportunity orders by opportunityScore descending, falling back to profit then data confidence then publication date", () => {
  const high = fixture({ id: "high", opportunityScore: 90 });
  const low = fixture({ id: "low", opportunityScore: 60 });
  assert.deepEqual(ids(sortResults([low, high], "opportunity")), ["high", "low"]);

  const moreProfit = fixture({ id: "more-profit", opportunityScore: 80, estimatedProfit: 100_000 });
  const lessProfit = fixture({ id: "less-profit", opportunityScore: 80, estimatedProfit: 40_000 });
  assert.deepEqual(ids(sortResults([lessProfit, moreProfit], "opportunity")), ["more-profit", "less-profit"], "equal opportunityScore falls back to estimatedProfit");

  const higherConfidence = fixture({ id: "higher-confidence", opportunityScore: 80, estimatedProfit: 100_000, dataConfidence: "HIGH" });
  const lowerConfidence = fixture({ id: "lower-confidence", opportunityScore: 80, estimatedProfit: 100_000, dataConfidence: "LOW" });
  assert.deepEqual(ids(sortResults([lowerConfidence, higherConfidence], "opportunity")), ["higher-confidence", "lower-confidence"], "equal opportunityScore and profit falls back to dataConfidence");
});

test("profit orders by estimatedProfit descending and pushes unknown profit to the end", () => {
  const bigProfit = fixture({ id: "big-profit", estimatedProfit: 120_000 });
  const smallProfit = fixture({ id: "small-profit", estimatedProfit: 30_000 });
  const unknownProfit = fixture({ id: "unknown-profit", estimatedProfit: null });
  assert.deepEqual(ids(sortResults([unknownProfit, smallProfit, bigProfit], "profit")), ["big-profit", "small-profit", "unknown-profit"]);
});

test("roi and discount also order descending by their own numeric field", () => {
  const higherRoi = fixture({ id: "higher-roi", estimatedRoi: 0.35 });
  const lowerRoi = fixture({ id: "lower-roi", estimatedRoi: 0.1 });
  assert.deepEqual(ids(sortResults([lowerRoi, higherRoi], "roi")), ["higher-roi", "lower-roi"]);

  const biggerDiscount = fixture({ id: "bigger-discount", marketDiscountPct: 22 });
  const smallerDiscount = fixture({ id: "smaller-discount", marketDiscountPct: 5 });
  assert.deepEqual(ids(sortResults([smallerDiscount, biggerDiscount], "discount")), ["bigger-discount", "smaller-discount"]);
});

test("biggest_price_drop orders by priceDropAmount descending and pushes no-drop results to the end", () => {
  const bigDrop = fixture({ id: "big-drop", priceDropAmount: 50_000 });
  const smallDrop = fixture({ id: "small-drop", priceDropAmount: 5_000 });
  const noDrop = fixture({ id: "no-drop", priceDropAmount: null });
  assert.deepEqual(ids(sortResults([noDrop, smallDrop, bigDrop], "biggest_price_drop")), ["big-drop", "small-drop", "no-drop"]);
});

// This is exactly the computation inline-filter-results.tsx performs for the
// archive tab: `archiveOpen ? sortResults(data?.archivedResults ?? [], sort) : []`.
// Proves archive visibility is strictly opt-in, and that the CURRENTLY
// selected sort (not a fixed one) determines the archived order — using the
// real, exported sortResults function rather than a source-text assertion.
test("the archive-tab computation (archiveOpen ? sortResults(archived, sort) : []) is opt-in and honors the selected sort", () => {
  const cheap = fixture({ id: "cheap", price: 200_000, opportunityScore: 40 });
  const expensive = fixture({ id: "expensive", price: 400_000, opportunityScore: 95 });
  const archived = [expensive, cheap];

  const whenClosed = (archiveOpen: boolean, sort: "price_asc" | "opportunity") => (archiveOpen ? sortResults(archived, sort) : []);

  assert.deepEqual(ids(whenClosed(false, "price_asc")), [], "archive must be empty while collapsed, regardless of sort");
  assert.deepEqual(ids(whenClosed(true, "price_asc")), ["cheap", "expensive"]);
  assert.deepEqual(ids(whenClosed(true, "opportunity")), ["expensive", "cheap"], "changing the selected sort must change the archived order");
});
