import assert from "node:assert/strict";
import test from "node:test";

import { authenticatedApiFetch } from "./authenticated-fetch.ts";

test("authenticated fetch sends a bearer for a valid session", async () => {
  let received: RequestInit | undefined;
  await authenticatedApiFetch("https://app.test/api", {}, {
    getAccessToken: async () => "valid-token",
    fetch: async (_input, init) => { received = init; return new Response(null, { status: 200 }); },
  });
  const headers = new Headers(received?.headers);
  assert.equal(headers.get("authorization"), "Bearer valid-token");
  assert.equal(received?.credentials, "include");
});

test("missing session still performs a safe cookie request", async () => {
  let calls = 0;
  let received: RequestInit | undefined;
  await authenticatedApiFetch("https://app.test/api", {}, {
    getAccessToken: async () => null,
    fetch: async (_input, init) => { calls += 1; received = init; return new Response(null, { status: 401 }); },
  });
  assert.equal(calls, 1);
  assert.equal(new Headers(received?.headers).has("authorization"), false);
  assert.equal(received?.credentials, "include");
});
