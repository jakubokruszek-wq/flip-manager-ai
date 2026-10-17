import assert from "node:assert/strict";
import test from "node:test";
import { handleAndroidMetadata, type AndroidMetadataDependencies } from "./metadata.ts";
import { MockAndroidStore, DEVICE } from "./fixtures.test-support.ts";
const request = (body = "{}") => new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json" }, body });
function deps(): AndroidMetadataDependencies { return { enabled: () => true, authenticate: async () => DEVICE, store: () => new MockAndroidStore(), loadSources: async () => [] }; }
test("metadata disabled does not enumerate any sources or queue", async () => {
  const d = deps(); d.enabled = () => false; d.loadSources = async () => { throw Error("unexpected DB access"); };
  const r = await handleAndroidMetadata(request(), "sources/sync", d); assert.equal(r.status, 503); assert.equal((await r.json()).code, "ANDROID_INTEGRATION_DISABLED");
});
test("source authorization uses authenticated device, never caller deviceId", async () => {
  const d = deps(); let device = ""; let path = ""; d.authenticate = async (_r,p) => { path=p; return DEVICE; };
  d.loadSources = async id => { device=id; return [{ id: "allowed", name: "Allowed", url: "https://facebook.com/profile.php?id=123456", priority: "high", enabled: true, access_status: "CONNECTED" }]; };
  const r = await handleAndroidMetadata(request('{"deviceId":"attacker"}'), "sources/sync", d); const body=await r.json();
  assert.equal(device, DEVICE); assert.equal(path,"/api/collector/android/sources/sync"); assert.equal(body.completeSnapshot,true); assert.equal(body.sources[0].type,"PROFILE");
});
test("unavailable and malformed sources are retained as disabled without promoting identity", async () => {
  const d=deps(); d.loadSources=async()=>[{ id:"bad",name:"Bad",url:"https://facebook.com/watch?id=123456",priority:"normal",enabled:true,access_status:"CONNECTED" },{ id:"unavailable",name:"Offline",url:"https://facebook.com/profile.php?id=789012",priority:"low",enabled:true,access_status:"UNAVAILABLE" }];
  const body=await (await handleAndroidMetadata(request(),"sources/sync",d)).json(); assert.equal(body.sources.length,2);
  assert.equal(body.sources[0].type,null); assert.equal(body.sources[0].enabled,false); assert.equal(body.sources[1].enabled,false);
});
test("device status returns no signing key; diagnostics requires owned lease", async () => {
  const d=deps(); const body=await (await handleAndroidMetadata(request(),"device/status",d)).json();
  assert.equal(body.deviceId,DEVICE); assert.equal(JSON.stringify(body).includes("token"),false);
  assert.equal((await handleAndroidMetadata(request(),"diagnostics",d)).status,400);
});
test("metadata rejects oversized streams and incomplete source snapshots", async () => {
  assert.equal((await handleAndroidMetadata(request("x".repeat(8193)),"sources/sync",deps())).status,413);
  const d=deps(); d.loadSources=async()=>Array.from({length:51},(_,i)=>({id:String(i),name:"Mock",url:"https://facebook.com/groups/mock/",priority:"normal",enabled:true,access_status:"CONNECTED"}));
  assert.equal((await handleAndroidMetadata(request(),"sources/sync",d)).status,503);
});
