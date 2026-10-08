import assert from "node:assert/strict";
import test from "node:test";
import { computeRadarStats, statGroupFor, type StatInputListing } from "./stats.ts";
import { MIN_RADAR_SAMPLE_SIZE } from "./types.ts";

function listing(overrides: Partial<StatInputListing> = {}): StatInputListing {
  return { district: "Bałuty", marketType: "secondary", pricePerSqm: 9_000, lastSeenAt: "2026-10-01T00:00:00Z", status: "active", excludedAt: null, ...overrides };
}

test("computes mean and median from individual prices/m2 only when the minimum sample is met", () => {
  const listings = Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, (_, index) => listing({ pricePerSqm: 8_000 + index * 100 }));
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.ok(group);
  assert.equal(group.averagePricePerSqm, 8_950);
  assert.equal(group.medianPricePerSqm, 8_950);
  assert.equal(group.sampleSize, MIN_RADAR_SAMPLE_SIZE);
});

test("median handles an even-sized sample by averaging the two middle values", () => {
  const listings = [
    ...Array.from({ length: MIN_RADAR_SAMPLE_SIZE - 1 }, (_, index) => listing({ pricePerSqm: 8_000 + index * 100 })),
    listing({ pricePerSqm: 12_000 }),
  ];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.medianPricePerSqm, 8_950);
});

test("secondary and primary markets never mix into one average, even for the same district", () => {
  const listings = [
    ...Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, () => listing({ marketType: "secondary", pricePerSqm: 8_000 })),
    ...Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, () => listing({ marketType: "primary", pricePerSqm: 14_000 })),
  ];
  const groups = computeRadarStats(listings);
  assert.equal(statGroupFor(groups, "Bałuty", "secondary")?.averagePricePerSqm, 8_000);
  assert.equal(statGroupFor(groups, "Bałuty", "primary")?.averagePricePerSqm, 14_000);
});

test("a sample of 19 exposes the real count and withholds mean/median reference prices", () => {
  const listings = Array.from({ length: MIN_RADAR_SAMPLE_SIZE - 1 }, () => listing());
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, 19);
  assert.equal(group?.isSmallSample, true);
  assert.equal(group?.averagePricePerSqm, null);
  assert.equal(group?.medianPricePerSqm, null);
});

test("sample sizes 20 and 21 expose confirmed reference prices", () => {
  const listings = Array.from({ length: MIN_RADAR_SAMPLE_SIZE + 1 }, (_, index) => listing({ pricePerSqm: 9_000 + index }));
  const atTwenty = statGroupFor(computeRadarStats(listings.slice(0, MIN_RADAR_SAMPLE_SIZE)), "Bałuty", "secondary");
  const atTwentyOne = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(atTwenty?.sampleSize, 20);
  assert.equal(atTwenty?.isSmallSample, false);
  assert.equal(atTwenty?.averagePricePerSqm, 9_009.5);
  assert.equal(atTwenty?.medianPricePerSqm, 9_009.5);
  assert.equal(atTwentyOne?.sampleSize, 21);
  assert.equal(atTwentyOne?.averagePricePerSqm, 9_010);
});

test("an excluded listing never contributes to the average, median, or sample count", () => {
  const listings = [...Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, () => listing({ pricePerSqm: 8_000 })), listing({ pricePerSqm: 100_000, excludedAt: "2026-10-01T00:00:00Z" })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, MIN_RADAR_SAMPLE_SIZE);
  assert.equal(group?.averagePricePerSqm, 8_000);
});

test("a removed (no longer active) listing never contributes either", () => {
  const listings = [...Array.from({ length: MIN_RADAR_SAMPLE_SIZE }, () => listing({ pricePerSqm: 8_000 })), listing({ pricePerSqm: 100_000, status: "removed" })];
  const group = statGroupFor(computeRadarStats(listings), "Bałuty", "secondary");
  assert.equal(group?.sampleSize, MIN_RADAR_SAMPLE_SIZE);
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
