import assert from "node:assert/strict";
import test from "node:test";
import { livePilotIngressConfig, livePilotStore, assertPilotBatch, validatePilotCompletion } from "./live-pilot-ingress.ts";
import { normalizeFacebookCollectorBatch } from "../facebook-batch.ts";
import { handleAndroidRequest } from "./handler.ts";
import { jobRow, completionPayload, MockAndroidStore } from "./fixtures.test-support.ts";
import { collectorSigningKey, createCollectorAuthHeaders, verifyCollectorAuth } from "../protocol.ts";
import { AndroidJobError } from "./jobs.ts";
const TOKEN="pilot-fixture-only-secret";
const env={FLIP_LIVE_PILOT_ENABLED:"true",FLIP_OFFLINE_REMOTE_TEST:"true",FLIP_LIVE_PILOT_DEVICE_ID:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  FLIP_LIVE_PILOT_SOURCE_REGISTRY_ID:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",FLIP_LIVE_PILOT_FACEBOOK_GROUP_ID:"1234567890",
  FLIP_LIVE_PILOT_SIGNING_KEY:collectorSigningKey(TOKEN),FLIP_LIVE_PILOT_EXPIRES_AT:String(Date.now()+1800_000)};
const remote={signingKey:"f".repeat(64),expiresAt:Date.now()+3600_000};
const config=livePilotIngressConfig(env,remote)!;
function row() { return jobRow({worker_id:config.deviceId,group_snapshot:[{id:config.sourceRegistryId,name:"Fixture pilot",type:"GROUP",sourceId:config.facebookGroupId,url:config.sourceUrl}]}); }
function payload() {
  const value=completionPayload(row());
  return {...value,batch:{...value.batch,health:{...value.batch.health,capturedPostCount:1,visibleCardCount:1},sourceId:config.facebookGroupId,sourceUrl:config.sourceUrl,posts:[{
    postId:"100000000001",permalink:config.sourceUrl+"posts/100000000001/",sourceId:config.facebookGroupId,sourceType:"GROUP",author:"Fixture",text:"Sprzedam mieszkanie 42 m2 Łódź 260 tys.",
    identityConfidence:"EXACT",identityReasons:[],discoveryLayers:["HYDRATION"],media:[],publishedAt:null,
  }]}};
}
test("pilot receiver defaults off and requires the dedicated remote domain",()=>{
  assert.equal(livePilotIngressConfig({},null),null);
  assert.throws(()=>livePilotIngressConfig(env,null),/ISOLATED/);
  for(const patch of [{SUPABASE_SERVICE_ROLE_KEY:"forbidden"},{OPENAI_API_KEY:"forbidden"},{FACEBOOK_ANDROID_ATOMIC_FINDER_ENABLED:"true"}])
    assert.throws(()=>livePilotIngressConfig({...env,...patch},remote),/ISOLATED/);
});
test("pilot approval rejects offline identity, shared key, fixture group and long expiry",()=>{
  for(const patch of [{FLIP_LIVE_PILOT_DEVICE_ID:"00000000-0000-4000-8000-000000000001"},{FLIP_LIVE_PILOT_SIGNING_KEY:remote.signingKey},
    {FLIP_LIVE_PILOT_FACEBOOK_GROUP_ID:"offline-lodz"},{FLIP_LIVE_PILOT_EXPIRES_AT:String(Date.now()-1)},
    {FLIP_LIVE_PILOT_EXPIRES_AT:String(Date.now()+7200_000)}]) assert.throws(()=>livePilotIngressConfig({...env,...patch},remote),/INVALID/);
});
test("receiver enforces max twenty, source and no Vision before reserving completion",()=>{
  const valid=payload();validatePilotCompletion(JSON.stringify(valid),config);
  const batch=normalizeFacebookCollectorBatch(valid.batch);
  assertPilotBatch(batch,config);
  assert.throws(()=>assertPilotBatch({...batch,posts:Array(21).fill(batch.posts[0])},config),/REJECTED/);
  assert.throws(()=>assertPilotBatch({...batch,sourceId:"other"},config),/REJECTED/);
  assert.throws(()=>assertPilotBatch({...batch,imageMode:"GALLERY_HYDRATION_MEDIA_ALLOWED"},config),/REJECTED/);
  assert.throws(()=>validatePilotCompletion(JSON.stringify({...valid,dataMode:"OFFLINE_TEST"}),config),/MODE/);
  assert.throws(()=>validatePilotCompletion(" ".repeat(512*1024+1),config),/LARGE/);
});
test("source restriction intersects SQL grants and cannot claim another group",async()=>{
  const base=new MockAndroidStore([row()]);const store=livePilotStore(base,config);
  await assert.rejects(async()=>await store.rpc("claim_android_facebook_scan_job",{p_device_id:config.deviceId,p_source_ids:["other"]}),/FORBIDDEN/);
  assert.equal(base.calls.length,0);
  assert.ok((await store.rpc("claim_android_facebook_scan_job",{p_device_id:config.deviceId})).data);
  base.jobs[0].group_snapshot=jobRow().group_snapshot;
  await assert.rejects(store.loadJob(base.jobs[0].id),/FORBIDDEN/);
  await assert.rejects(async()=>await store.rpc("renew_android_facebook_scan_job",{p_device_id:config.deviceId,p_job_id:base.jobs[0].id,p_lease_token:base.jobs[0].lease_token}),/FORBIDDEN/);
});
test("signed LIVE fixture completion replays one receipt; wrong key/nonce never imports",async()=>{
  const base=new MockAndroidStore([row()]);const nonces=new Set<string>();let imports=0;
  const body=JSON.stringify(payload());const pathname="/api/collector/android/jobs/complete";
  function request(token=TOKEN,nonce?:string) {
    const h=createCollectorAuthHeaders({deviceId:config.deviceId,deviceToken:token,method:"POST",pathname,body,nonce});
    return new Request("https://test.invalid"+pathname,{method:"POST",body,headers:{"content-type":"application/json","x-flip-collector-device-id":h.deviceId,
      "x-flip-collector-timestamp":h.timestamp,"x-flip-collector-nonce":h.nonce,"x-flip-collector-signature":h.signature}});
  }
  const deps={enabled:()=>true,expectedDataMode:"LIVE" as const,atomicPilotImportReplay:true,store:()=>livePilotStore(base,config),
    authenticate:async(req:Request,path:string,raw:string)=>{
      const auth=await verifyCollectorAuth({signingKey:config.signingKey,method:req.method,pathname:path,body:raw,headers:req.headers,
        useNonce:async nonce=>{if(nonces.has(nonce))return false;nonces.add(nonce);return true;}});
      if(!auth.ok)throw new AndroidJobError(401,auth.code);
      validatePilotCompletion(raw,config);return config.deviceId;
    },processBatch:async()=>{imports++;return {status:"completed"};}};
  assert.equal((await handleAndroidRequest(request("offline-token"),"complete",deps)).status,401);
  const first=await handleAndroidRequest(request(TOKEN,"pilot_fixture_nonce_123456"),"complete",deps);assert.equal(first.status,200);
  const receipt=await first.json();
  assert.equal((await handleAndroidRequest(request(TOKEN,"pilot_fixture_nonce_123456"),"complete",deps)).status,401);
  const retried=await handleAndroidRequest(request(),"complete",deps);
  assert.deepEqual(await retried.json(),receipt);assert.equal(imports,1);
});
