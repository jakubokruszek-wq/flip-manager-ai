import { test } from "node:test";
import assert from "node:assert/strict";
import { collectorGroupFeed, createCollectorGroupsGet } from "./facebook-groups-feed.ts";
import type { WatchedFacebookGroup } from "../facebook-groups/types.ts";
const group = (patch: Partial<WatchedFacebookGroup> = {}): WatchedFacebookGroup => ({
  id: "registry-id", type: "GROUP", sourceId: "lodzsprzedazzakupwynajem", name: "Łódź sprzedaż zakup wynajem",
  nameVerified: true, url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/", city: "Łódź",
  district: null, neighborhood: null, priority: "high", keywords: [], enabled: true,
  accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: "private details",
  ...patch,
});
const request = (token = "A".repeat(43)) => new Request("https://manager.test/api/collector/facebook/groups", { headers: { authorization: `Bearer ${token}` } });
test("same registry, only enabled groups; source identities remain distinct", () => {
  const feed = collectorGroupFeed([group(), group({ id: "second", sourceId: "402796264871862", url: "https://www.facebook.com/groups/402796264871862/", name: "Łódź sprzedaż zakup wynajem" }), group({ enabled: false }), group({ type: "PROFILE" })]);
  assert.equal(feed.groups.length, 2);
  assert.notEqual(feed.groups[0].groupId, feed.groups[1].groupId);
  assert(!JSON.stringify(feed).includes("private details"));
  assert(!("lastCheckedAt" in feed.groups[0]));
});
test("no alias inference, duplicate identity or malformed registry is accepted", () => {
  for (const rows of [[group(), group()], [group({ sourceId: "other" })], [group({ url: "https://evil.test/groups/lodzsprzedazzakupwynajem/" })]]) assert.throws(() => collectorGroupFeed(rows));
  assert.equal(collectorGroupFeed([group({ nameVerified: false })]).groups[0].name, "Nieznana grupa");
});
test("missing, malformed and revoked tokens cannot read the registry", async () => {
  let reads = 0, auth = 0;
  const get = createCollectorGroupsGet({ authenticate: async () => { auth++; throw new Error("revoked secret"); }, list: async () => { reads++; return [group()]; }, authStatus: () => 401 });
  for (const token of ["", "bad", "A".repeat(43)]) {
    const response = await get(request(token)); assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert(!JSON.stringify(await response.json()).includes("secret"));
  }
  assert.equal(reads, 0); assert.equal(auth, 1);
});
test("authentication precedes reading, no cached success on database failure", async () => {
  const order: string[] = [];
  const get = createCollectorGroupsGet({ authenticate: async () => { order.push("auth"); }, list: async () => { order.push("read"); return [group()]; }, authStatus: () => 503 });
  const response = await get(request()); assert.equal(response.status, 200); assert.equal(response.headers.get("vary"), "Authorization");
  assert.deepEqual(order, ["auth", "read"]); assert.equal((await response.json()).groups.length, 1);
  const failed = createCollectorGroupsGet({ authenticate: async () => {}, list: async () => { throw Error("SQL private"); }, authStatus: () => 503 });
  assert.deepEqual(await (await failed(request())).json(), { code: "GROUPS_UNAVAILABLE" });
});
