import assert from "node:assert/strict";
import test, { mock } from "node:test";

let operatorAllowed = false;
let adminConstructions = 0;
let rpcCalls = 0;

mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => { if (!operatorAllowed) throw new Error("OPERATOR_SESSION_REQUIRED"); return { id: "operator", email: null }; },
    operatorAuthorizationResponse: () => Response.json({ ok: false, code: "OPERATOR_SESSION_REQUIRED" }, { status: 401 }),
  },
});
mock.module("@/lib/supabase/admin", {
  namedExports: {
    createAdminClient: () => {
      adminConstructions += 1;
      return {
        rpc: async () => {
          rpcCalls += 1;
          return { data: [{ lifecycle_status: "ACTIVE", membership_count: 1 }], error: null };
        },
      };
    },
  },
});

const route = await import("../../app/api/flip-finder/listings/[id]/review/route.ts");
const LISTING = "11111111-1111-4111-8111-111111111111";

function request(headers: Record<string, string> = {}) {
  return new Request(`https://flip-manager.test/api/flip-finder/listings/${LISTING}/review`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ decision: "ACCEPTED" }),
  });
}

test("forged browser headers without a session fail before service-role construction", async () => {
  operatorAllowed = false;
  adminConstructions = 0;
  rpcCalls = 0;
  const response = await route.POST(request({ origin: "https://flip-manager-ai.vercel.app", "sec-fetch-site": "same-origin", "x-flip-finder-action": "review-listing" }), { params: Promise.resolve({ id: LISTING }) });
  assert.equal(response.status, 401);
  assert.equal(adminConstructions, 0);
  assert.equal(rpcCalls, 0);
});

test("a valid operator reaches the atomic RPC", async () => {
  operatorAllowed = true;
  adminConstructions = 0;
  rpcCalls = 0;
  const response = await route.POST(request(), { params: Promise.resolve({ id: LISTING }) });
  assert.equal(response.status, 200);
  assert.equal(adminConstructions, 1);
  assert.equal(rpcCalls, 1);
});

test("malformed listing IDs are rejected before service-role construction", async () => {
  operatorAllowed = true;
  adminConstructions = 0;
  const response = await route.POST(request(), { params: Promise.resolve({ id: "1111----evil" }) });
  assert.equal(response.status, 422);
  assert.equal(adminConstructions, 0);
});
