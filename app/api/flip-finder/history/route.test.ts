import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../../../features/facebook-watcher/server/facebook-fake-supabase.ts";

/** "Usuń wszystkie oferty" is permanent: it must be off by default, typed-confirmed and bound to the count the operator saw. */
let db = new FakeFacebookSupabase();
let authorized = true;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (!authorized) throw new Error("unauthorized"); return { id: "operator", email: "o@example.test" }; },
  operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
} });
const { GET, DELETE } = await import("./route.ts");
const { HISTORY_DELETE_CONFIRMATION, HISTORY_DELETE_ENV } = await import("../../../../features/flip-finder/history-delete-guard.ts");

function seeded(): FakeFacebookSupabase {
  return new FakeFacebookSupabase()
    .seed("listings", [{ id: "a", source: "olx" }, { id: "b", source: "otodom" }, { id: "c", source: "gratka" }])
    .seed("listing_snapshots", [{ id: "s1", listing_id: "a" }, { id: "s2", listing_id: "b" }])
    .seed("search_filters", [{ id: "f1" }, { id: "f2" }])
    .seed("source_scans", []).seed("facebook_scan_jobs", []).seed("olx_scan_jobs", []);
}
const request = (body: unknown) => new Request("http://localhost/api/flip-finder/history", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.beforeEach(() => { db = seeded(); authorized = true; delete process.env[HISTORY_DELETE_ENV]; });

test("the preview reports the real scale (all filters and portals) and that deleting is disabled by default", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, enabled: false, enableVariable: HISTORY_DELETE_ENV, confirmation: HISTORY_DELETE_CONFIRMATION, listings: 3, priceSnapshots: 2, filters: 2 });
});

test("disabled by default: even a fully confirmed request deletes nothing", async () => {
  const response = await DELETE(request({ confirmation: HISTORY_DELETE_CONFIRMATION, expectedListings: 3 }));
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { code: string }).code, "HISTORY_DELETE_DISABLED");
  assert.equal(db.rows("listings").length, 3);
});

test("enabled: a request without the exact typed phrase (the old one-click request included) deletes nothing", async () => {
  process.env[HISTORY_DELETE_ENV] = "true";
  for (const body of [null, {}, { confirmation: "usuń wszystkie oferty", expectedListings: 3 }, { confirmation: HISTORY_DELETE_CONFIRMATION }]) {
    const response = await DELETE(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(db.rows("listings").length, 3);
});

test("enabled: a count that changed since the preview cancels the delete", async () => {
  process.env[HISTORY_DELETE_ENV] = "true";
  const response = await DELETE(request({ confirmation: HISTORY_DELETE_CONFIRMATION, expectedListings: 2 }));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "HISTORY_DELETE_COUNT_CHANGED");
  assert.equal(db.rows("listings").length, 3);
});

test("enabled: an active scan still blocks the delete", async () => {
  process.env[HISTORY_DELETE_ENV] = "true";
  db.seed("source_scans", [{ id: "scan", status: "running" }]);
  const response = await DELETE(request({ confirmation: HISTORY_DELETE_CONFIRMATION, expectedListings: 3 }));
  assert.equal(response.status, 409);
  assert.equal(db.rows("listings").length, 3);
});

test("only an authorized operator can preview or delete", async () => {
  authorized = false;
  process.env[HISTORY_DELETE_ENV] = "true";
  assert.equal((await GET()).status, 401);
  assert.equal((await DELETE(request({ confirmation: HISTORY_DELETE_CONFIRMATION, expectedListings: 3 }))).status, 401);
  assert.equal(db.rows("listings").length, 3);
});

test("enabled, typed phrase and the previewed count: the delete runs (behaviour of the explicit, intended path is kept)", async () => {
  process.env[HISTORY_DELETE_ENV] = "true";
  const response = await DELETE(request({ confirmation: HISTORY_DELETE_CONFIRMATION, expectedListings: 3 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { ok: boolean }).ok, true);
  assert.equal(db.rows("listings").length, 0);
  assert.equal(db.rows("search_filters").length, 2, "filters are never deleted");
});
