import assert from "node:assert/strict";
import test, { mock } from "node:test";

const FILTER_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_A = "22222222-2222-4222-8222-222222222222";
const LISTING_B = "33333333-3333-4333-8333-333333333333";
let operatorFails = false;
let filterAvailable = true;
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: { action: "link" }, error: null };
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => {
      if (operatorFails) throw new Error("operator required");
      return { id: "44444444-4444-4444-8444-444444444444", email: "operator@example.test" };
    },
    operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
  },
});
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => filterAvailable ? { id: FILTER_ID } : null } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({ rpc: (name: string, args: Record<string, unknown>) => { rpcCalls.push({ name, args }); return Promise.resolve(rpcResult); } }) } });

const { POST } = await import("./route.ts");

function request(body: unknown) {
  return POST(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: FILTER_ID }) });
}

test("unauthorized requests do not reach privileged identity RPC", async () => {
  operatorFails = true;
  rpcCalls.length = 0;
  try {
    const response = await request({ action: "link", listingA: LISTING_A, listingB: LISTING_B });
    assert.equal(response.status, 401);
    assert.equal(rpcCalls.length, 0);
  } finally { operatorFails = false; }
});

test("an unavailable filter is not used as a service-role identity scope", async () => {
  filterAvailable = false;
  rpcCalls.length = 0;
  try {
    const response = await request({ action: "link", listingA: LISTING_A, listingB: LISTING_B });
    assert.equal(response.status, 404);
    assert.equal(rpcCalls.length, 0);
  } finally { filterAvailable = true; }
});

test("authorized manual decisions pass the authenticated operator and exact filter/listing scope to the RPC", async () => {
  rpcCalls.length = 0;
  rpcResult = { data: { action: "link" }, error: null };
  const response = await request({ action: "link", listingA: LISTING_A, listingB: LISTING_B });
  assert.equal(response.status, 200);
  assert.deepEqual(rpcCalls, [{
    name: "manage_finder_listing_identity",
    args: {
      p_owner_id: "44444444-4444-4444-8444-444444444444",
      p_search_filter_id: FILTER_ID,
      p_action: "link",
      p_listing_a: LISTING_A,
      p_listing_b: LISTING_B,
    },
  }]);
});

test("an unapplied draft is reported as feature unavailable, while conflicts remain explicit", async () => {
  rpcResult = { data: null, error: { code: "PGRST202", message: "manage_finder_listing_identity was not found" } };
  const unavailable = await request({ action: "link", listingA: LISTING_A, listingB: LISTING_B });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as { code: string }).code, "IDENTITY_SCHEMA_REQUIRED");

  rpcResult = { data: null, error: { code: "22023", message: "FINDER_IDENTITY_CONTRADICTORY_EVIDENCE" } };
  const conflict = await request({ action: "link", listingA: LISTING_A, listingB: LISTING_B });
  assert.equal(conflict.status, 409);
});
