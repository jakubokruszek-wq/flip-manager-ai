import assert from "node:assert/strict";
import test from "node:test";
import { computeRadarStats, statGroupFor, type StatInputListing } from "./stats.ts";
import { MIN_RADAR_SAMPLE_SIZE } from "./types.ts";

function listing(overrides: Partial<StatInputListing> = {}): StatInputListing {
  return { district: "Bałuty", marketType: "secondary", pricePerSqm: 9_000, lastSeenAt: "2026-10-01T00:00:00Z", status: "active", excludedAt: null, ...overrides };
}

test("computes mean and median price/m2 for a district+market group", () => {
  const listings = [listing({ pricePerSqm: 8_000 }), listing({ pricePerSqm: 9_000 }), listing({ pricePerSqm: 10_000 })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.ok(group);
  assert.equal(group.averagePricePerSqm, 9_000);
  assert.equal(group.medianPricePerSqm, 9_000);
  assert.equal(group.sampleSize, 3);
});

test("median handles an even-sized sample by averaging the two middle values", () => {
  const listings = [listing({ pricePerSqm: 8_000 }), listing({ pricePerSqm: 9_000 }), listing({ pricePerSqm: 10_000 }), listing({ pricePerSqm: 11_000 })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.medianPricePerSqm, 9_500);
});

test("secondary and primary markets never mix into one average, even for the same district", () => {
  const listings = [
    listing({ marketType: "secondary", pricePerSqm: 8_000 }),
    listing({ marketType: "primary", pricePerSqm: 14_000 }),
  ];
  const groups = computeRadarStats(listings);
  assert.equal(statGroupFor(groups, "Bałuty", "secondary")?.averagePricePerSqm, 8_000);
  assert.equal(statGroupFor(groups, "Bałuty", "primary")?.averagePricePerSqm, 14_000);
});

test("a sample below MIN_RADAR_SAMPLE_SIZE is flagged isSmallSample but still reported with its real count, never hidden", () => {
  const listings = Array.from({ length: 5 }, () => listing());
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, 5);
  assert.equal(group?.isSmallSample, true);
});

test("a sample at or above MIN_RADAR_SAMPLE_SIZE is not flagged", () => {
  const listings = Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, () => listing());
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, MIN_RADAR_SAMPLE_SIZE);
  assert.equal(group?.isSmallSample, false);
});

test("an excluded listing never contributes to the average, median, or sample count", () => {
  const listings = [listing({ pricePerSqm: 8_000 }), listing({ pricePerSqm: 100_000, excludedAt: "2026-10-01T00:00:00Z" })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, 1);
  assert.equal(group?.averagePricePerSqm, 8_000);
});

test("a removed (no longer active) listing never contributes either", () => {
  const listings = [listing({ pricePerSqm: 8_000 }), listing({ pricePerSqm: 100_000, status: "removed" })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, 1);
});

test("updatedAt is the most recent lastSeenAt in the sample", () => {
  const listings = [listing({ lastSeenAt: "2026-10-01T00:00:00Z" }), listing({ lastSeenAt: "2026-10-05T00:00:00Z" }), listing({ lastSeenAt: "2026-10-03T00:00:00Z" })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.updatedAt, "2026-10-05T00:00:00Z");
});

test("an empty sample for a district/market combination is simply absent from the result, not a zero-filled fabrication", () => {
  const groups = computeRadarStats([]);
  assert.equal(groups.length, 0);
  assert.equal(statGroupFor(groups, "Widzew", "primary"), null);
});
