import assert from "node:assert/strict";
import test from "node:test";

import { authenticateApiUserWithClient, type ApiAuthClient } from "./api-auth-core.ts";

test("valid SSR cookie authenticates without reading bearer", async () => {
  const calls: Array<string | undefined> = [];
  const user = await authenticateApiUserWithClient(request("bearer-token"), client(calls, { cookie: "user-cookie", bearer: null }));
  assert.equal(user?.id, "user-cookie");
  assert.deepEqual(calls, [undefined]);
});

test("missing cookie falls back to server-validated bearer", async () => {
  const calls: Array<string | undefined> = [];
  const user = await authenticateApiUserWithClient(request("valid-token"), client(calls, { cookie: null, bearer: "user-bearer" }));
  assert.equal(user?.id, "user-bearer");
  assert.deepEqual(calls, [undefined, "valid-token"]);
});

test("invalid bearer is anonymous", async () => {
  const user = await authenticateApiUserWithClient(request("invalid"), client([], { cookie: null, bearer: null }));
  assert.equal(user, null);
});

test("missing cookie and bearer is anonymous", async () => {
  const calls: Array<string | undefined> = [];
  const user = await authenticateApiUserWithClient(new Request("https://app.test/api"), client(calls, { cookie: null, bearer: null }));
  assert.equal(user, null);
  assert.deepEqual(calls, [undefined]);
});

function request(token: string): Request {
  return new Request("https://app.test/api", { headers: { authorization: `Bearer ${token}` } });
}

function client(calls: Array<string | undefined>, users: { cookie: string | null; bearer: string | null }): ApiAuthClient {
  return { auth: { async getUser(token?: string) {
    calls.push(token);
    const id = token === undefined ? users.cookie : users.bearer;
    return { data: { user: id ? { id } : null }, error: id ? null : new Error("invalid") };
  } } };
}
