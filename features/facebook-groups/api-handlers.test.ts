import assert from "node:assert/strict";
import test from "node:test";
import { createFacebookGroupsApi } from "./api-handlers.ts";
import type { WatchedFacebookGroup } from "./types.ts";

const group = { id: "11111111-1111-4111-8111-111111111111", name: "Grupa", url: "https://www.facebook.com/groups/grupa/", city: "Łódź", district: null, neighborhood: null, priority: "normal", keywords: [], enabled: true, accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null } satisfies WatchedFacebookGroup;

function api(authenticated: boolean) {
  return createFacebookGroupsApi({
    requireUser: async () => { if (!authenticated) throw new Error("UNAUTHORIZED"); },
    list: async () => [group, { ...group, id: "22222222-2222-4222-8222-222222222222" }, { ...group, id: "33333333-3333-4333-8333-333333333333" }],
    add: async () => ({ success: true, duplicate: false, group }),
    update: async (_id, value) => ({ ...group, enabled: (value as { enabled?: boolean }).enabled ?? group.enabled }),
    remove: async () => ({ ...group, enabled: false }),
  });
}

test("authenticated GET returns all three groups", async () => {
  const response = await api(true).get();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).groups.length, 3);
});

test("anonymous GET returns 401", async () => assert.equal((await api(false).get()).status, 401));

test("authenticated PATCH and DELETE work", async () => {
  const handlers = api(true);
  const patch = await handlers.patch(group.id, new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ enabled: false }) }));
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).group.enabled, false);
  const remove = await handlers.delete(group.id);
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).group.enabled, false);
});
