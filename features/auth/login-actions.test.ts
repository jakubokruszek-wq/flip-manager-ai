import assert from "node:assert/strict";
import test, { mock } from "node:test";

let signInError: { message: string } | null = null;
let verifiedUser: { app_metadata: Record<string, unknown> } | null = { app_metadata: { role: "operator" } };
let signOutCalls = 0;
let redirectTarget: string | null = null;

mock.module("server-only", { defaultExport: {} });
mock.module("next/navigation", {
  namedExports: {
    redirect: (target: string) => {
      redirectTarget = target;
      throw new Error(`NEXT_REDIRECT:${target}`);
    },
  },
});
mock.module("@/lib/supabase/auth-server", {
  namedExports: {
    createAuthServerClient: async () => ({
      auth: {
        signInWithPassword: async () => ({ error: signInError }),
        getUser: async () => ({ data: { user: verifiedUser }, error: null }),
        signOut: async () => { signOutCalls += 1; return { error: null }; },
      },
    }),
  },
});
mock.module("@/features/auth/return-to", {
  namedExports: { safeReturnTo: (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard" },
});

const { loginOperator } = await import("../../app/login/actions.ts");

function form(returnTo = "/dashboard") {
  const data = new FormData();
  data.set("email", "operator@example.test");
  data.set("password", "correct horse battery staple");
  data.set("returnTo", returnTo);
  return data;
}

test("failed login returns clear feedback and never redirects", async () => {
  signInError = { message: "invalid credentials" };
  redirectTarget = null;
  assert.deepEqual(await loginOperator({ error: null }, form()), { error: "Nieprawidłowy e-mail lub hasło." });
  assert.equal(redirectTarget, null);
  signInError = null;
});

test("a non-operator login is invalidated", async () => {
  verifiedUser = { app_metadata: {} };
  signOutCalls = 0;
  assert.deepEqual(await loginOperator({ error: null }, form()), { error: "To konto nie ma dostępu operatora." });
  assert.equal(signOutCalls, 1);
});

test("operator login redirects to a safe requested path", async () => {
  verifiedUser = { app_metadata: { role: "operator" } };
  redirectTarget = null;
  await assert.rejects(loginOperator({ error: null }, form("/facebook-watcher?tab=review")), /NEXT_REDIRECT/);
  assert.equal(redirectTarget, "/facebook-watcher?tab=review");
});
