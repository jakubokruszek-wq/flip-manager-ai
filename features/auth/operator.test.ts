import assert from "node:assert/strict";
import test, { mock } from "node:test";

let getUserResult: { data: { user: unknown }; error: unknown } = { data: { user: null }, error: null };

mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/auth-server", {
  namedExports: {
    createAuthServerClient: async () => ({ auth: { getUser: async () => getUserResult } }),
  },
});

const { OperatorAuthorizationError, requireOperator } = await import("./operator.ts");

function user(appMetadata: Record<string, unknown>, userMetadata: Record<string, unknown> = {}) {
  return { id: "11111111-1111-4111-8111-111111111111", email: "operator@example.test", app_metadata: appMetadata, user_metadata: userMetadata };
}

async function rejected(status: number) {
  await assert.rejects(requireOperator(), (error: unknown) => error instanceof OperatorAuthorizationError && error.status === status);
}

test("missing and invalid sessions are rejected with 401", async () => {
  getUserResult = { data: { user: null }, error: null };
  await rejected(401);
  getUserResult = { data: { user: null }, error: { message: "expired access token" } };
  await rejected(401);
});

test("a valid user without the operator app role is rejected with 403", async () => {
  getUserResult = { data: { user: user({}) }, error: null };
  await rejected(403);
});

test("user_metadata cannot authorize, while app_metadata.role=operator can", async () => {
  getUserResult = { data: { user: user({}, { role: "operator" }) }, error: null };
  await rejected(403);
  getUserResult = { data: { user: user({ role: "operator" }) }, error: null };
  assert.deepEqual(await requireOperator(), {
    id: "11111111-1111-4111-8111-111111111111",
    email: "operator@example.test",
  });
});

test("returned identity is bounded and contains no session credentials", async () => {
  getUserResult = { data: { user: { ...user({ role: "operator" }), id: "x".repeat(500), email: `${"a".repeat(400)}@example.test`, access_token: "secret" } }, error: null };
  const identity = await requireOperator();
  assert.equal(identity.id.length, 128);
  assert.equal(identity.email?.length, 320);
  assert.deepEqual(Object.keys(identity).sort(), ["email", "id"]);
});
