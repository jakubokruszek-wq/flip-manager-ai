import assert from "node:assert/strict";
import test from "node:test";
import { createFacebookGroupDiscoveryApi, createFacebookGroupHistoricalMappingApi, createFacebookGroupImportApi, createFacebookGroupsApi } from "./api-handlers.ts";
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

test("discovery POST parses candidates and returns whatever the injected preview function classifies", async () => {
  const api = createFacebookGroupDiscoveryApi({
    preview: async (candidates) => candidates.map((c) => ({ url: c.url, normalizedUrl: c.url, identifier: "x", discoveredName: c.name, status: "NOWA" as const, reason: "ok" })),
  });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ candidates: [{ url: "https://www.facebook.com/groups/example/", name: "Example" }] }) }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.length, 1);
  assert.equal(body.preview[0].status, "NOWA");
});

test("discovery POST rejects a payload with no candidates array", async () => {
  const api = createFacebookGroupDiscoveryApi({ preview: async () => [] });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({}) }));
  assert.equal(response.status, 400);
});

test("discovery GET returns the last stored preview (bridges the extension's facebook.com tab and the Manager page)", async () => {
  const api = createFacebookGroupDiscoveryApi({
    preview: async () => [],
    lastPreview: () => ({ preview: [{ url: "https://www.facebook.com/groups/x/", normalizedUrl: "https://www.facebook.com/groups/x/", identifier: "x", discoveredName: "X", status: "NOWA", reason: "ok" }], generatedAt: "2026-09-23T00:00:00.000Z" }),
  });
  const response = await api.get();
  const body = await response.json();
  assert.equal(body.preview.length, 1);
  assert.equal(body.generatedAt, "2026-09-23T00:00:00.000Z");
});

test("discovery GET returns an empty preview when nothing has been discovered yet", async () => {
  const api = createFacebookGroupDiscoveryApi({ preview: async () => [] });
  const response = await api.get();
  const body = await response.json();
  assert.deepEqual(body.preview, []);
  assert.equal(body.generatedAt, null);
});

// The extension is the caller of this endpoint, not a logged-in app session
// (this app runs without a login boundary) — so, exactly like every other
// extension-to-server write, it must be authenticated with the signed-device
// scheme, and a failed signature must reject before preview() ever runs.
test("discovery POST rejects an unauthenticated request before ever calling preview(), surfacing the auth error's own status", async () => {
  let previewCalled = false;
  class FakeAuthError extends Error { status = 401; }
  const api = createFacebookGroupDiscoveryApi({
    preview: async () => { previewCalled = true; return []; },
    authenticate: async () => { throw new FakeAuthError("INVALID_DEVICE"); },
  });
  const response = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ candidates: [{ url: "https://www.facebook.com/groups/example/" }] }) }));
  assert.equal(response.status, 401);
  assert.equal(previewCalled, false);
});

test("import POST requires a non-empty selection with a real name for every entry", async () => {
  const api = createFacebookGroupImportApi({ importSelected: async (selections) => selections.map((s) => ({ url: s.url, result: { success: true, duplicate: false, group: { id: "x", name: s.name } as never } })) });
  const missingName = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ selections: [{ url: "https://www.facebook.com/groups/example/" }] }) }));
  assert.equal(missingName.status, 400);
  const empty = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ selections: [] }) }));
  assert.equal(empty.status, 400);
  const ok = await api.post(new Request("http://localhost", { method: "POST", body: JSON.stringify({ selections: [{ url: "https://www.facebook.com/groups/example/", name: "Example Group" }] }) }));
  assert.equal(ok.status, 200);
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
