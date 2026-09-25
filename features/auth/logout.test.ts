import assert from "node:assert/strict";
import test, { mock } from "node:test";

let authorized = true;
let signOutCalls = 0;
let redirectTarget: string | null = null;

mock.module("next/navigation", {
  namedExports: { redirect: (target: string) => { redirectTarget = target; throw new Error(`NEXT_REDIRECT:${target}`); } },
});
mock.module("@/features/auth/operator", {
  namedExports: { requireOperator: async () => { if (!authorized) throw new Error("unauthorized"); return { id: "operator", email: null }; } },
});
mock.module("@/lib/supabase/auth-server", {
  namedExports: { createAuthServerClient: async () => ({ auth: { signOut: async () => { signOutCalls += 1; return { error: null }; } } }) },
});

const { logoutOperator } = await import("./actions.ts");

test("logout invalidates the Supabase session and returns to login", async () => {
  authorized = true;
  signOutCalls = 0;
  redirectTarget = null;
  await assert.rejects(logoutOperator(), /NEXT_REDIRECT/);
  assert.equal(signOutCalls, 1);
  assert.equal(redirectTarget, "/login");
});

test("logout never calls signOut before authorization", async () => {
  authorized = false;
  signOutCalls = 0;
  await assert.rejects(logoutOperator(), /unauthorized/);
  assert.equal(signOutCalls, 0);
});
