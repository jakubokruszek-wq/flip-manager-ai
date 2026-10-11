import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("server-only", { namedExports: {} });

type Row = Record<string, unknown>;

function settingsDb() {
  const rows: Row[] = [];
  return {
    rows,
    from(table: string) {
      assert.equal(table, "price_radar_settings");
      const filters: Record<string, unknown> = {};
      let payload: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        maybeSingle: async () => ({ data: rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }),
        upsert: (value: Row) => { payload = value; return builder; },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          if (payload) {
            const index = rows.findIndex((row) => row.owner_id === payload?.owner_id);
            if (index >= 0) rows[index] = { ...payload };
            else rows.push({ ...payload });
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const { readRadarSettings, radarSettingsSourcesWereFilteredToEmpty, writeRadarSettings } = await import("./radar-settings.ts");

test("the optional minimum price per m² round-trips through the owner-scoped JSON settings row", async () => {
  const db = settingsDb();
  const saved = await writeRadarSettings("operator-1", {
    districts: ["Bałuty"], market: "both", areaMin: 31, areaMax: 62, rooms: [1, 2, 3], sources: ["oferty_net"], minPricePerSqm: 8_800,
  }, db as never);

  assert.equal(saved.minPricePerSqm, 8_800);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]?.owner_id, "operator-1");
  assert.equal((db.rows[0]?.filters as Row).minPricePerSqm, 8_800);

  const reread = await readRadarSettings("operator-1", db as never);
  assert.deepEqual(reread, saved, "refresh reads the persisted threshold back through the normalizer");
});

test("a legacy saved JSON settings row without the optional minimum remains disabled", async () => {
  const db = settingsDb();
  db.rows.push({ owner_id: "operator-1", filters: { districts: ["Bałuty"], sources: ["oferty_net"] } });
  const loaded = await readRadarSettings("operator-1", db as never);
  assert.equal(loaded.minPricePerSqm, null);
});

test("a legacy row that explicitly named only szybko reads back with an empty source list, but is flagged so a caller never treats it as 'scan everything'", async () => {
  const db = settingsDb();
  db.rows.push({ owner_id: "operator-szybko-only", filters: { districts: ["Bałuty"], sources: ["szybko"] } });
  const loaded = await readRadarSettings("operator-szybko-only", db as never);
  assert.deepEqual(loaded.sources, [], "szybko never survives normalization");
  assert.equal(await radarSettingsSourcesWereFilteredToEmpty("operator-szybko-only", db as never), true, "an explicit but now-fully-disabled selection must be distinguishable from genuinely choosing nothing");
});

test("an operator who genuinely selected nothing is never flagged -- an empty selection legitimately means 'all active sources'", async () => {
  const db = settingsDb();
  db.rows.push({ owner_id: "operator-no-selection", filters: { districts: ["Bałuty"], sources: [] } });
  assert.equal(await radarSettingsSourcesWereFilteredToEmpty("operator-no-selection", db as never), false);
  assert.equal(await radarSettingsSourcesWereFilteredToEmpty("operator-never-saved", db as never), false, "no saved row at all is also never flagged");
});

test("a mixed selection with at least one still-active source alongside szybko is never flagged -- it correctly keeps running on what remains", async () => {
  const db = settingsDb();
  db.rows.push({ owner_id: "operator-mixed", filters: { districts: ["Bałuty"], sources: ["szybko", "domiporta"] } });
  const loaded = await readRadarSettings("operator-mixed", db as never);
  assert.deepEqual(loaded.sources, ["domiporta"]);
  assert.equal(await radarSettingsSourcesWereFilteredToEmpty("operator-mixed", db as never), false);
});
