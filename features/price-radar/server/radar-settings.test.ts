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

const { readRadarSettings, writeRadarSettings } = await import("./radar-settings.ts");

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
