import test from "node:test";
import assert from "node:assert/strict";
import { parseMobileDiscovery, createMobileDiscoveryPost } from "./facebook-mobile-discovery.ts";
const data = () => ({ version: 1, pageUrl: "https://www.facebook.com/groups/joins/", groups: [{ url: "https://www.facebook.com/groups/123456789/", name: "Nieruchomości Łódź" }] });
test("membership metadata is bounded and never includes posts, secrets, images or guesses", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  assert.deepEqual(parseMobileDiscovery(data(), now), [{ ...data().groups[0], discoveredAt: now.toISOString() }]);
  assert.equal(parseMobileDiscovery({ ...data(), groups: [{ ...data().groups[0], name: null }] })?.[0].name, null);
  for (const bad of [{ ...data(), postText: "private" }, { ...data(), pageUrl: "https://www.facebook.com/groups/feed/" }, { ...data(), groups: [] }, { ...data(), groups: [data().groups[0], data().groups[0]] }, { ...data(), groups: [{ url: "https://evil.test/groups/123456789/", name: "Łódź" }] }, { ...data(), groups: [{ url: "https://www.facebook.com/groups/joins/", name: "Grupy" }] }, { ...data(), groups: [{ ...data().groups[0], name: "raw\ntext" }] }]) assert.equal(parseMobileDiscovery(bad), null);
});
test("authenticate before body reads, bind the session to that device and preserve bounded handoff", async () => {
  let writes = 0; const secret = "A".repeat(43);
  const post = createMobileDiscoveryPost({ authenticate: async token => { assert.equal(token, secret); return { id: "owned" }; }, discover: async (candidates, id) => { writes++; assert.equal(id, "owned"); assert.equal(candidates.length, 1); return { token: "opaque", expiresAt: "later" }; }, authStatus: () => null });
  const req = (body: string, auth = true) => new Request("https://manager/discover", { method: "POST", headers: auth ? { authorization: `Bearer ${secret}` } : {}, body });
  assert.equal((await post(req(JSON.stringify(data()), false))).status, 401); assert.equal(writes, 0);
  assert.equal((await post(req("x".repeat(128 * 1024 + 1)))).status, 413); assert.equal(writes, 0);
  assert.equal((await post(req(JSON.stringify({ ...data(), groups: [] })))).status, 422); assert.equal(writes, 0);
  const response = await post(req(JSON.stringify(data()))); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.deepEqual(await response.json(), { token: "opaque", expiresAt: "later" }); assert.equal(writes, 1);
});
