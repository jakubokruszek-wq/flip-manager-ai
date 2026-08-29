import assert from "node:assert/strict";
import test from "node:test";

import { apiFetch } from "./api-fetch.ts";

test("public API fetch does not require or add a browser session", async () => {
  let received: RequestInit | undefined;
  await apiFetch("https://app.test/api", {}, async (_input, init) => {
    received = init;
    return new Response(null, { status: 200 });
  });
  assert.equal(new Headers(received?.headers).has("authorization"), false);
  assert.equal(received?.credentials, "same-origin");
});

test("public API fetch preserves explicit request options", async () => {
  let received: RequestInit | undefined;
  await apiFetch("https://app.test/api", { cache: "no-store", credentials: "omit" }, async (_input, init) => {
    received = init;
    return new Response(null, { status: 200 });
  });
  assert.equal(received?.cache, "no-store");
  assert.equal(received?.credentials, "omit");
});

test("browser-like fetch keeps its required receiver context", async () => {
  const browser = {
    fetch(this: { fetch: typeof globalThis.fetch }, input: RequestInfo | URL, init?: RequestInit) {
      assert.equal(this, browser);
      void input;
      void init;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  await apiFetch("https://app.test/api", {}, (...args) => browser.fetch(...args));
});
