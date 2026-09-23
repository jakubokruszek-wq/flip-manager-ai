import assert from "node:assert/strict";
import test from "node:test";
import { createFacebookGroupDiscoveryApi, createFacebookGroupDiscoveryPreviewApi, createFacebookGroupHistoricalMappingApi, createFacebookGroupImportApi, createFacebookGroupsApi } from "./api-handlers.ts";
import type { WatchedFacebookGroup } from "./types.ts";

const group = { id: "11111111-1111-4111-8111-111111111111", name: "Grupa", url: "https://www.facebook.com/groups/grupa/", city: "Łódź", district: null, neighborhood: null, priority: "normal", keywords: [], enabled: true, accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null } satisfies WatchedFacebookGroup;

function api() {
  return createFacebookGroupsApi({
    list: async () => [group, { ...group, id: "22222222-2222-4222-8222-222222222222" }, { ...group, id: "33333333-3333-4333-8333-333333333333" }],
    add: async () => ({ success: true, duplicate: false, group }),
    update: async (_id, value) => ({ ...group, enabled: (value as { enabled?: boolean }).enabled ?? group.enabled }),
    remove: async () => ({ ...group, enabled: false }),
  });
}

test("public GET returns all three groups without a browser session", async () => {
  const response = await api().get();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).groups.length, 3);
});

test("public POST works without a browser session", async () => {
  const response = await api().post(new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({ url: group.url }),
  }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).success, true);
});

test("public PATCH and DELETE work without a browser session", async () => {
  const handlers = api();
  const patch = await handlers.patch(group.id, new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: false }) }));
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).group.enabled, false);
  const remove = await handlers.delete(group.id);
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).group.enabled, false);
});

test("discovery POST parses candidates, authenticates, and returns an opaque session token -- never the candidates themselves", async () => {
  const api = createFacebookGroupDiscoveryApi({
    discover: async (candidates, deviceId) => { assert.equal(candidates.length, 1); assert.equal(deviceId, "device-1"); return { token: "session-token", expiresAt: "2026-09-23T00:10:00.000Z" }; },
    authenticate: async () => ({ deviceId: "device-1" }),
  });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ candidates: [{ url: "https://www.facebook.com/groups/example/", name: "Example" }] }) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.token, "session-token");
  assert.equal(body.preview, undefined, "the discover response must never itself contain the discovered candidates or their classification");
});

test("discovery POST rejects a payload with no candidates array", async () => {
  const api = createFacebookGroupDiscoveryApi({ discover: async () => ({ token: "x", expiresAt: "" }), authenticate: async () => ({ deviceId: null }) });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({}) }));
  assert.equal(response.status, 400);
});

// The extension is the caller of this endpoint, not a logged-in app session
// (this app runs without a login boundary) — so, exactly like every other
// extension-to-server write, it must be authenticated with the signed-device
// scheme, and a failed signature must reject before discover() ever runs.
test("discovery POST rejects an unauthenticated request before ever calling discover(), surfacing the auth error's own status", async () => {
  let discoverCalled = false;
  class FakeAuthError extends Error { status = 401; }
  const api = createFacebookGroupDiscoveryApi({
    discover: async () => { discoverCalled = true; return { token: "x", expiresAt: "" }; },
    authenticate: async () => { throw new FakeAuthError("INVALID_DEVICE"); },
  });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ candidates: [{ url: "https://www.facebook.com/groups/example/" }] }) }));
  assert.equal(response.status, 401);
  assert.equal(discoverCalled, false);
});

test("discovery preview POST requires a token and returns 404 (not a distinguishing error) for a wrong/expired one, always no-store", async () => {
  const api = createFacebookGroupDiscoveryPreviewApi({ preview: async (token) => (token === "good-token" ? { preview: [], expiresAt: "2026-09-23T00:10:00.000Z", consumedAt: null } : null) });
  const missing = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({}) }));
  assert.equal(missing.status, 400);
  const wrong = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "bad-token" }) }));
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get("cache-control"), "no-store");
  const ok = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "good-token" }) }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("import POST requires a token and a non-empty selection with a real name for every entry, always no-store", async () => {
  const api = createFacebookGroupImportApi({ importSelected: async (token, selections) => (token === "good-token" ? selections.map((s) => ({ url: s.url, result: { success: true, duplicate: false, group: { id: "x", name: s.name } as never } })) : null) });
  const missingToken = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ selections: [{ url: "https://www.facebook.com/groups/example/", name: "Example" }] }) }));
  assert.equal(missingToken.status, 400);
  const wrongToken = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "bad-token", selections: [{ url: "https://www.facebook.com/groups/example/", name: "Example" }] }) }));
  assert.equal(wrongToken.status, 404);
  const missingName = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "good-token", selections: [{ url: "https://www.facebook.com/groups/example/" }] }) }));
  assert.equal(missingName.status, 400);
  const empty = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "good-token", selections: [] }) }));
  assert.equal(empty.status, 400);
  const ok = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ token: "good-token", selections: [{ url: "https://www.facebook.com/groups/example/", name: "Example Group" }] }) }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.json();
  assert.equal(body.outcomes.length, 1);
});

test("historical mapping GET returns whatever the injected mapping function reports", async () => {
  const api = createFacebookGroupHistoricalMappingApi({ mapping: async () => [{ sourceId: "402796264871862", sourceUrl: "https://www.facebook.com/groups/402796264871862/", sourceType: "GROUP", name: "Nieznana grupa", isNamed: false }] });
  const response = await api.get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mapping.length, 1);
  assert.equal(body.mapping[0].name, "Nieznana grupa");
});
