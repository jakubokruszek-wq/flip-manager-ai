import assert from "node:assert/strict";
import test, { mock } from "node:test";

// Reimplemented locally rather than imported from the real module: the real
// "@/features/auth/operator" transitively imports next/headers via
// createAuthServerClient, which is unavailable outside the Next runtime.
class OperatorAuthorizationError extends Error {
  readonly status: 401 | 403;
  readonly code: "OPERATOR_SESSION_REQUIRED" | "OPERATOR_ROLE_REQUIRED";
  constructor(status: 401 | 403, code: "OPERATOR_SESSION_REQUIRED" | "OPERATOR_ROLE_REQUIRED") {
    super(code);
    this.name = "OperatorAuthorizationError";
    this.status = status;
    this.code = code;
  }
}
function operatorAuthorizationResponse(error: unknown): Response {
  if (error instanceof OperatorAuthorizationError) return Response.json({ ok: false, code: error.code }, { status: error.status });
  throw error;
}
mock.module("@/features/auth/operator", {
  namedExports: {
    OperatorAuthorizationError,
    operatorAuthorizationResponse,
    requireOperator: async () => ({ id: "operator-1", email: "operator@example.com" }),
  },
});

// Mission (Section 4): investigated fresh whether "Usuń nieruchomość" can
// ever delete the wrong table. No current UI path was found that passes a
// listings id into the properties delete flow (PropertyDeleteControl is only
// ever rendered with a genuine property.id from /api/properties, and
// import-from-finder always inserts a NEW properties row with its own
// generated id, distinct from listing_id). That could not be reproduced —
// documented explicitly in the mission's final report. This test instead
// proves the defensive hardening that was added regardless: a listings id
// must never be silently reported as "not found" the same way a genuinely
// nonexistent id is, since that generic message is exactly what would mask
// a real wrong-table bug from whoever debugs it next.
const propertiesTable = new Map<string, { id: string }>();
const listingsTable = new Map<string, { id: string }>();

function fakeAdminClient() {
  return {
    from: (table: string) => {
      if (table === "properties") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({ data: propertiesTable.get(id) ?? null, error: null }),
            }),
          }),
          delete: () => ({
            eq: async (_column: string, id: string) => { propertiesTable.delete(id); return { error: null }; },
          }),
        };
      }
      if (table === "listings") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({ data: listingsTable.get(id) ?? null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table touched by property delete: ${table}`);
    },
  };
}
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: fakeAdminClient } });

const route = await import("../../../app/api/properties/[id]/route.ts");

function deleteRequest(id: string) {
  return { params: Promise.resolve({ id }) };
}

test("deleting a genuine property id deletes it from public.properties", async () => {
  propertiesTable.clear();
  listingsTable.clear();
  propertiesTable.set("prop-1", { id: "prop-1" });
  const response = await route.DELETE(new Request("https://x/api/properties/prop-1", { method: "DELETE" }), deleteRequest("prop-1"));
  assert.equal(response.status, 204);
  assert.equal(propertiesTable.has("prop-1"), false);
});

test("a genuinely nonexistent id (in neither table) returns the plain not-found message", async () => {
  propertiesTable.clear();
  listingsTable.clear();
  const response = await route.DELETE(new Request("https://x/api/properties/ghost", { method: "DELETE" }), deleteRequest("ghost"));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.message, "Nie znaleziono nieruchomości.");
  assert.equal(body.code, undefined);
});

test("an id that belongs to public.listings, not public.properties, is never deleted and never gets the generic not-found message", async () => {
  propertiesTable.clear();
  listingsTable.clear();
  listingsTable.set("listing-1", { id: "listing-1" });
  const response = await route.DELETE(new Request("https://x/api/properties/listing-1", { method: "DELETE" }), deleteRequest("listing-1"));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "ID_BELONGS_TO_LISTING");
  assert.match(body.message, /public\.listings/);
  assert.notEqual(body.message, "Nie znaleziono nieruchomości.");
  // The listing itself must never be touched by this endpoint.
  assert.equal(listingsTable.has("listing-1"), true);
});
