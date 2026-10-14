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
  assert.equal(DEFAULT_RADAR_FILTERS.automaticScanEnabled, true, "the existing daily automation remains enabled for legacy users");
  assert.equal(DEFAULT_RADAR_FILTERS.automaticScanTime, "05:00");
  assert.deepEqual(normalizeRadarFilters(null), DEFAULT_RADAR_FILTERS);
});

test("automation settings round-trip and malformed clocks fall back to 05:00", () => {
  const saved = normalizeRadarFilters({ automaticScanEnabled: false, automaticScanTime: "06:35" });
  assert.equal(saved.automaticScanEnabled, false);
  assert.equal(saved.automaticScanTime, "06:35");
  assert.equal(normalizeRadarFilters({ automaticScanEnabled: true, automaticScanTime: "23:59" }).automaticScanTime, "23:59");
  for (const time of ["24:00", "12:60", "5:00", "05:0x", ""])
    assert.equal(normalizeRadarFilters({ automaticScanTime: time }).automaticScanTime, "05:00", `${time} is rejected`);
  assert.equal(normalizeRadarFilters({ automaticScanEnabled: "false" }).automaticScanEnabled, true);
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

test("szybko is never accepted into saved Radar settings -- old saved settings and a direct API request are both stripped", () => {
  assert.equal(RADAR_SOURCES.includes("szybko" as (typeof RADAR_SOURCES)[number]), false, "szybko must not be a schema-ready Radar source at all");
  // A legacy saved settings row from before szybko was disabled.
  const legacySaved = normalizeRadarFilters({ districts: ["Bałuty"], sources: ["domiporta", "szybko"] });
  assert.deepEqual(legacySaved.sources, ["domiporta"], "an old saved settings row listing szybko must never resurrect it on read");
  // A direct, crafted API PUT request trying to re-add it.
  const directApiAttempt = normalizeRadarFilters({ districts: ["Bałuty"], sources: ["szybko"] });
  assert.deepEqual(directApiAttempt.sources, [], "a direct API request naming only szybko ends up with an empty, not a widened, source list");
});

test("OLX is not a Radar source: stored or submitted settings drop it on the server", () => {
  assert.ok(!RADAR_SOURCES.includes("olx" as never), "OLX stays a Flip Finder-only source");
  assert.ok(RADAR_SOURCES.includes("otodom" as never), "the other portals stay");
  assert.deepEqual(normalizeRadarFilters({ sources: ["olx"] }).sources, [], "a legacy OLX-only selection means all current Radar sources");
  assert.deepEqual(normalizeRadarFilters({ sources: ["olx", "otodom", "gratka"] }).sources, ["otodom", "gratka"]);
});
