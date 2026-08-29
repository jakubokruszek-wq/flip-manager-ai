import assert from "node:assert/strict";
import test from "node:test";
import { attachFacebookNetworkDiagnostics, networkDiagnosticsSummary } from "./network-diagnostics.ts";

test("network diagnostics records safe feed response metadata without exposing query strings", async () => {
  let listener: ((response: unknown) => void) | undefined;
  const page = { on: (_event: string, callback: (response: unknown) => void) => { listener = callback; } } as never;
  const state = attachFacebookNetworkDiagnostics(page, true)!;
  listener?.({
    url: () => "https://www.facebook.com/ajax/graphql/?access_token=secret",
    status: () => 200,
    headers: () => ({ "content-type": "application/json; charset=utf-8" }),
    request: () => ({ resourceType: () => "xhr", method: () => "POST" }),
    text: async () => JSON.stringify({ story_id: "1575051567646320", media_id: "9876543210123", message: "64 m2" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const summary = networkDiagnosticsSummary(state);
  assert.equal(summary.relevantResponses, 1);
  assert.deepEqual(summary.postIds, ["1575051567646320"]);
  assert.deepEqual(summary.mediaIds, ["9876543210123"]);
});

test("network diagnostics is disabled by default", () => {
  const page = { on: () => { throw new Error("listener must not attach"); } } as never;
  assert.equal(attachFacebookNetworkDiagnostics(page, false), null);
});
