import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[]) {
  return {
    rows,
    async rpc(name: string, args: Row) {
      assert.equal(name, "set_price_radar_listing_exclusion");
      const selected = rows.find((row) => row.owner_id === args.p_owner_id && row.id === args.p_listing_id);
      if (!selected) return { data: false, error: null };
      for (const row of rows) {
        if (row.owner_id !== args.p_owner_id || (row.id !== selected.id && (!selected.cross_source_identity || row.cross_source_identity !== selected.cross_source_identity))) continue;
        row.excluded_at = args.p_excluded ? row.excluded_at ?? new Date().toISOString() : null;
        row.excluded_reason = args.p_excluded ? args.p_reason : null;
      }
      return { data: true, error: null };
    },
  };
}

let currentDb: ReturnType<typeof fakeDb>;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentDb } });
const { excludeRadarListing, restoreRadarListing } = await import("./radar-exclusion.ts");
const ownerId = "owner-1";

test("exclude and restore propagate only through the same owner's confirmed cross-portal identity", async () => {
  currentDb = fakeDb([
    { id: "listing-1", owner_id: ownerId, cross_source_identity: "portal_shared_unit_id:x", excluded_at: null, excluded_reason: null },
    { id: "listing-2", owner_id: ownerId, cross_source_identity: "portal_shared_unit_id:x", excluded_at: null, excluded_reason: null },
    { id: "other-owner", owner_id: "owner-2", cross_source_identity: "portal_shared_unit_id:x", excluded_at: null, excluded_reason: null },
  ]);
  const result = await excludeRadarListing(ownerId, "listing-1", "poza budżetem", currentDb as never);
  assert.deepEqual(result, { ok: true });
  assert.ok(currentDb.rows[0].excluded_at);
  assert.equal(currentDb.rows[0].excluded_reason, "poza budżetem");
  assert.ok(currentDb.rows[1].excluded_at);
  assert.equal(currentDb.rows[2].excluded_at, null, "owner boundary is part of the identity group");
  await restoreRadarListing(ownerId, "listing-2", currentDb as never);
  assert.equal(currentDb.rows[0].excluded_at, null);
  assert.equal(currentDb.rows[1].excluded_at, null);
});

test("excludeRadarListing on a nonexistent id reports not_found, never throws", async () => {
  currentDb = fakeDb([]);
  const result = await excludeRadarListing(ownerId, "missing", null, currentDb as never);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("restoreRadarListing clears excluded_at/excluded_reason", async () => {
  currentDb = fakeDb([{ id: "listing-1", owner_id: ownerId, excluded_at: "2026-10-01T00:00:00Z", excluded_reason: "poza budżetem" }]);
  const result = await restoreRadarListing(ownerId, "listing-1", currentDb as never);
  assert.deepEqual(result, { ok: true });
  assert.equal(currentDb.rows[0].excluded_at, null);
  assert.equal(currentDb.rows[0].excluded_reason, null);
});
