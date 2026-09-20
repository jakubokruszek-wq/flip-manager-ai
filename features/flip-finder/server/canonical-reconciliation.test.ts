import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileCanonicalListingDecision, type CanonicalReconciliationFailureDiagnostic } from "./canonical-reconciliation.ts";

type RpcResponse = { data: unknown; error: { code: string; message: string; details: string; hint: string } | null };

function fakeSupabase(response: RpcResponse): SupabaseClient {
  return {
    rpc: () => {
      const promise = Promise.resolve(response) as Promise<RpcResponse> & { abortSignal: () => typeof promise };
      promise.abortSignal = () => promise;
      return promise;
    },
  } as unknown as SupabaseClient;
}

const BASE_INPUT = {
  listingId: "11111111-1111-1111-1111-111111111111",
  filterId: "22222222-2222-2222-2222-222222222222",
  decision: { bucket: "REVIEW" as const, reasons: [], missingFields: ["topFloor"], hardRejectReasons: [] },
};

test("a Postgres error (e.g. 23505 unique_violation) is surfaced unchanged in message and attached in full as Error.cause", async () => {
  const supabase = fakeSupabase({
    data: null,
    error: { code: "23505", message: "duplicate key value violates unique constraint \"listing_filter_matches_pkey\"", details: "Key (listing_id, search_filter_id)=(11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222) already exists.", hint: "" },
  });
  await assert.rejects(
    reconcileCanonicalListingDecision({ supabase, ...BASE_INPUT }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "CANONICAL_RECONCILIATION_FAILED: duplicate key value violates unique constraint \"listing_filter_matches_pkey\"");
      const cause = error.cause as CanonicalReconciliationFailureDiagnostic;
      assert.deepEqual(cause, {
        listingId: BASE_INPUT.listingId,
        filterId: BASE_INPUT.filterId,
        errorCode: "23505",
        errorMessage: "duplicate key value violates unique constraint \"listing_filter_matches_pkey\"",
        errorDetails: "Key (listing_id, search_filter_id)=(11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222) already exists.",
        errorHint: null,
      });
      return true;
    },
  );
});

test("a PostgREST-style error code (e.g. PGRST116, result-shape failure) is attached the same way", async () => {
  const supabase = fakeSupabase({
    data: null,
    error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "Results contain 0 rows", hint: "" },
  });
  await assert.rejects(
    reconcileCanonicalListingDecision({ supabase, ...BASE_INPUT }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const cause = error.cause as CanonicalReconciliationFailureDiagnostic;
      assert.equal(cause.errorCode, "PGRST116");
      assert.equal(cause.errorDetails, "Results contain 0 rows");
      assert.equal(cause.errorHint, null);
      return true;
    },
  );
});

test("a fake with only .message set (no code/details/hint) degrades to null fields, never throws while building the diagnostic", async () => {
  const supabase = fakeSupabase({ data: null, error: { code: undefined, message: "rpc unavailable", details: undefined, hint: undefined } as unknown as RpcResponse["error"] });
  await assert.rejects(
    reconcileCanonicalListingDecision({ supabase, ...BASE_INPUT }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const cause = error.cause as CanonicalReconciliationFailureDiagnostic;
      assert.deepEqual(cause, { listingId: BASE_INPUT.listingId, filterId: BASE_INPUT.filterId, errorCode: null, errorMessage: "rpc unavailable", errorDetails: null, errorHint: null });
      return true;
    },
  );
});

test("a missing-result response (no error, but no row) still attaches listingId/filterId with null DB fields", async () => {
  const supabase = fakeSupabase({ data: null, error: null });
  await assert.rejects(
    reconcileCanonicalListingDecision({ supabase, ...BASE_INPUT }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "CANONICAL_RECONCILIATION_FAILED: missing result");
      const cause = error.cause as CanonicalReconciliationFailureDiagnostic;
      assert.deepEqual(cause, { listingId: BASE_INPUT.listingId, filterId: BASE_INPUT.filterId, errorCode: null, errorMessage: "missing result", errorDetails: null, errorHint: null });
      return true;
    },
  );
});

test("a successful RPC call is completely unaffected: no cause, normal result, no behavioral change", async () => {
  const supabase = fakeSupabase({ data: [{ listing_id: BASE_INPUT.listingId, search_filter_id: BASE_INPUT.filterId, bucket: "REVIEW", lifecycle_status: "REVIEW", is_current_match: false, match_reasons: ["review", "unknown_topFloor"] }], error: null });
  const result = await reconcileCanonicalListingDecision({ supabase, ...BASE_INPUT });
  assert.deepEqual(result, {
    listingId: BASE_INPUT.listingId,
    searchFilterId: BASE_INPUT.filterId,
    bucket: "REVIEW",
    lifecycleStatus: "REVIEW",
    isCurrentMatch: false,
    matchReasons: ["review", "unknown_topFloor"],
  });
});
