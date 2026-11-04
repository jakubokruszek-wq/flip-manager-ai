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
  const response = await get(request()); assert.equal(response.status, 200); assert.equal(response.headers.get("vary"), "Authorization, X-Watcher-Group-Protocol");
  assert.deepEqual(order, ["auth", "read"]); assert.equal((await response.json()).groups.length, 1);
  const failed = createCollectorGroupsGet({ authenticate: async () => {}, list: async () => { throw Error("SQL private"); }, authStatus: () => 503 });
  assert.deepEqual(await (await failed(request())).json(), { code: "GROUPS_UNAVAILABLE" });
});


test("adding FLIPERZY POLSKA cannot break the closed eleven-group Android feed",async()=>{
  const rows=[group(),group({id:"new",sourceId:"297408205383031",url:"https://www.facebook.com/groups/297408205383031/",name:"FLIPERZY POLSKA"})];
  const get=createCollectorGroupsGet({authenticate:async()=>{},list:async()=>rows,authStatus:()=>503});
  const legacy=await(await get(request())).json();
  assert.deepEqual(legacy.groups.map((g:{groupId:string})=>g.groupId),["lodzsprzedazzakupwynajem"]);
  assert.equal(legacy.compatibility.omittedGroupCount,1);
  const modernRequest=request();modernRequest.headers.set("x-watcher-group-protocol","2");
  const modern=await(await get(modernRequest)).json();
  assert.equal(modern.groups.length,2);assert.equal(modern.groups[1].groupId,"297408205383031");
  assert.equal(modern.compatibility.omittedGroupCount,0);
});
