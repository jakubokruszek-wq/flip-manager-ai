import assert from "node:assert/strict";
import test from "node:test";

const { RADAR_SOURCES } = await import("./server/collect.ts");
const { DEFAULT_RADAR_FILTERS, normalizeRadarFilters } = await import("./settings.ts");

test("Radar defaults are Łódź districts, both markets, no narrow limits, and all active sources", () => {
  assert.deepEqual(DEFAULT_RADAR_FILTERS.districts, ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"]);
  assert.equal(DEFAULT_RADAR_FILTERS.market, "both");
  assert.equal(DEFAULT_RADAR_FILTERS.areaMin, null);
  assert.equal(DEFAULT_RADAR_FILTERS.areaMax, null);
  assert.deepEqual(DEFAULT_RADAR_FILTERS.rooms, []);
  assert.deepEqual(DEFAULT_RADAR_FILTERS.sources, []);
  assert.equal(DEFAULT_RADAR_FILTERS.minPricePerSqm, null, "the optional unit-price filter is off by default");
  assert.deepEqual(normalizeRadarFilters(null), DEFAULT_RADAR_FILTERS);
});

test("saved filters retain only actually registered, schema-ready Radar adapters and normalize comparison bounds", () => {
  assert.ok(RADAR_SOURCES.includes("domiporta"));
  const filters = normalizeRadarFilters({
    districts: ["Bałuty", "Rzeszów", "Bałuty"], market: "secondary", areaMin: 20, areaMax: 80,
    rooms: [2, 2, 11, 0], sources: ["domiporta", "facebook", "bezposrednio", "official_auction", "unknown"],
  });
  assert.deepEqual(filters.districts, ["Bałuty"]);
  assert.equal(filters.market, "secondary");
  assert.equal(filters.areaMin, 20);
  assert.equal(filters.areaMax, 80);
  assert.deepEqual(filters.rooms, [2]);
  assert.deepEqual(filters.sources, ["domiporta"]);
  const withMinimum = normalizeRadarFilters({ districts: ["Bałuty"], minPricePerSqm: 8_800 });
  assert.equal(withMinimum.minPricePerSqm, 8_800);
  assert.equal(normalizeRadarFilters({ minPricePerSqm: -1 }).minPricePerSqm, null);
  assert.equal(normalizeRadarFilters({ minPricePerSqm: 100_001 }).minPricePerSqm, null);
  assert.ok(filters.sources.every((source) => RADAR_SOURCES.includes(source)));
});

test("malformed values cannot widen the district, room, or portal sets beyond Radar's active lists", () => {
  const filters = normalizeRadarFilters({ districts: ["Oslo"], market: "garbage", areaMin: -1, areaMax: Infinity, rooms: [100], sources: ["facebook"] });
  assert.deepEqual(filters.districts, DEFAULT_RADAR_FILTERS.districts);
  assert.equal(filters.market, "both");
  assert.equal(filters.areaMin, null);
  assert.equal(filters.areaMax, null);
  assert.deepEqual(filters.rooms, []);
  assert.deepEqual(filters.sources, []);
});
