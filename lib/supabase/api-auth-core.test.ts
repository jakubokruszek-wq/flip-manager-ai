import assert from "node:assert/strict";
import test from "node:test";

import { authenticateApiUserWithClient, authenticateApiUserWithDiagnostics, type ApiAuthClient } from "./api-auth-core.ts";

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

test("diagnostics identify cookie auth and do not attempt bearer", async () => {
  const result = await authenticateApiUserWithDiagnostics(request("bad"), client([], { cookie: "cookie-user", bearer: null }));
  assert.equal(result.diagnostics.cookieGetUserSuccess, true);
  assert.equal(result.diagnostics.authSource, "cookie");
  assert.equal(result.diagnostics.bearerGetUserAttempted, false);
});

test("diagnostics identify valid bearer fallback", async () => {
  const result = await authenticateApiUserWithDiagnostics(request("good"), client([], { cookie: null, bearer: "bearer-user" }));
  assert.equal(result.diagnostics.authorizationPresent, true);
  assert.equal(result.diagnostics.bearerParseSuccess, true);
  assert.equal(result.diagnostics.bearerGetUserSuccess, true);
  assert.equal(result.diagnostics.authSource, "bearer");
});

test("invalid bearer and no auth are safely marked anonymous", async () => {
  const invalid = await authenticateApiUserWithDiagnostics(request("bad"), client([], { cookie: null, bearer: null }));
  const none = await authenticateApiUserWithDiagnostics(new Request("https://app.test/api"), client([], { cookie: null, bearer: null }));
  assert.equal(invalid.diagnostics.bearerParseSuccess, true);
  assert.equal(invalid.diagnostics.bearerGetUserSuccess, false);
  assert.equal(invalid.diagnostics.authSource, "none");
  assert.equal(none.diagnostics.userPresent, false);
  assert.equal(none.diagnostics.authSource, "none");
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
