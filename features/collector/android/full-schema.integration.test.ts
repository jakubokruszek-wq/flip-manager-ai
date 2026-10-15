/** Actual Watcher -> Finder orchestration over PostgREST and native PostgreSQL.
 * Only the admin-client factory is substituted. No persistence/normalization RPC is mocked. */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHmac, randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAndroidDataOnlyImport, type AndroidFinderOwnership } from "./import-policy.ts";
import { persistAndroidFinderPost } from "./finder-write.ts";
import { handleAndroidRequest } from "./handler.ts";
import { collectorSigningKey, createCollectorAuthHeaders } from "../protocol.ts";
if (process.env.GITHUB_ACTIONS !== "true" && process.env.FLIP_ISOLATED_TESTS !== "1") throw Error("ISOLATED_TESTS_ONLY");
const secret="isolated-full-schema-postgrest-signing-key-only";
let loseNextPostResponse=false;
function jwt(role: string) {
  const head=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const body=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  return head+"."+body+"."+createHmac("sha256",secret).update(head+"."+body).digest("base64url");
}
// Standalone PostgREST has no Supabase gateway. Remove only its /rest/v1
// prefix and forbid all other hosts; SQL and client query builders stay real.
const gateway: typeof fetch=async(input,init)=>{
  const url=new URL(typeof input==="string" || input instanceof URL ? input.toString() : input.url);
  if(url.origin!=="http://127.0.0.1:55442" || !url.pathname.startsWith("/rest/v1/")) throw Error("ISOLATED_GATEWAY_ONLY");
  url.pathname=url.pathname.slice("/rest/v1".length);
  const response=await fetch(url,init);
  if(loseNextPostResponse && url.pathname==="/rpc/persist_android_facebook_finder_post" && response.ok) {
    loseNextPostResponse=false;await response.text();
    return Response.json({code:"ISOLATED_RESPONSE_LOST",message:"Synthetic post-commit response loss"},{status:503});
  }
  return response;
};
const db=createClient("http://127.0.0.1:55442",jwt("service_role"),{global:{fetch:gateway},auth:{persistSession:false,autoRefreshToken:false}});
mock.module("@/features/facebook-watcher/supabase-admin",{namedExports:{createFacebookWatcherAdminClient:()=>db}});
mock.module("@/lib/supabase/admin",{namedExports:{createAdminClient:()=>db}});
const {importFacebookWatcher}=await import("../../facebook-watcher/server.ts");
const {getSearchFilter}=await import("../../flip-finder/server/search-filters.ts");
const {processFacebookCollectorBatch}=await import("../facebook-batch-server.ts");
const {authenticateSignedCollectorRequest,SignedCollectorAuthError}=await import("../signed-device-auth.ts");
const {androidJobStore}=await import("./server.ts");
const {AndroidJobError}=await import("./jobs.ts");
let schemaReady=false;
for(let n=0;n<30;n++) {
  const probe=await db.from("search_filters").select("id").limit(1);
  if(!probe.error){schemaReady=true;break;}
  await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal(schemaReady,true,"PostgREST schema/role did not become ready");
const filter=await getSearchFilter("66666666-6666-4666-8666-666666666666",{supabase:db});
assert.ok(filter);
const context={filter,sourceScanId:"44444444-4444-4444-8444-444444444444",groupId:"synthetic-lodz",groupName:"Synthetic only",groupUrl:"https://www.facebook.com/groups/synthetic-lodz/",postId:"987654321012345",checkedAt:new Date().toISOString(),imageMode:"SEARCH_DATA_FIRST" as const};
const input={url:"https://www.facebook.com/groups/synthetic-lodz/posts/987654321012345/",postText:"Sprzedam mieszkanie 50 m2, 2 pokoje, Łódź Bałuty, w bloku z cegły. Cena 260 tyś. zł. Bezpośrednio właściciel.",images:[]};
async function ownership(profile=false,reserve=true): Promise<AndroidFinderOwnership> {
  const deviceId=randomUUID(),jobId=randomUUID(),sourceScanId=randomUUID(),completionId=randomUUID(),runId=randomUUID();
  const payloadHash=createHash("sha256").update(completionId).digest("hex");
  const groupId=profile ? "00000000-0000-4000-8000-000000000009" : "00000000-0000-4000-8000-000000000008";
  const group={id:groupId,name:context.groupName,url:profile ? "https://www.facebook.com/profile.php?id=123456" : context.groupUrl,sourceId:profile ? "123456" : context.groupId,type:profile ? "PROFILE" : "GROUP"};
  for(const result of [
    await db.from("collector_devices").insert({id:deviceId,device_name:"Synthetic test",installation_id:deviceId,token_hash:createHash("sha256").update(deviceId).digest("hex"),consumer_type:"ANDROID_WEBVIEW"}),
    await db.from("watched_facebook_groups").upsert({id:groupId,name:"Synthetic only",url:group.url,enabled:true,access_status:"CONNECTED"}),
    await db.from("source_scans").insert({id:sourceScanId,search_filter_id:context.filter.id,source:"facebook",status:"running",scan_run_id:runId,filter_snapshot:context.filter}),
    await db.from("collector_android_source_grants").insert({device_id:deviceId,watched_group_id:groupId,search_filter_id:context.filter.id}),
    await db.from("facebook_scan_jobs").insert({id:jobId,scan_run_id:runId,source_scan_id:sourceScanId,search_filter_id:context.filter.id,consumer_type:"ANDROID_WEBVIEW",idempotency_key:jobId,
      group_snapshot:[group]})
  ]) assert.equal(result.error,null,result.error?.message);
  const claimed=await db.rpc("claim_android_facebook_scan_job",{p_device_id:deviceId,p_lease_seconds:180});
  assert.equal(claimed.error,null);const lease:unknown=claimed.data;
  assert.ok(Array.isArray(lease) && lease.length===1 && typeof lease[0].lease_token==="string" && typeof lease[0].id==="string" && typeof lease[0].source_scan_id==="string");
  const leaseToken=String(lease[0].lease_token);
  const claimedJobId=String(lease[0].id),claimedScanId=String(lease[0].source_scan_id);
  if(reserve) {
    const begun=await db.rpc("begin_android_facebook_finder_completion",{p_job_id:claimedJobId,p_device_id:deviceId,p_lease_token:leaseToken,p_completion_id:completionId,p_payload_hash:payloadHash});
    assert.equal(begun.error,null);assert.equal(begun.data?.outcome,"reserved");
  }
  return {jobId:claimedJobId,deviceId,sourceScanId:claimedScanId,completionId,leaseToken,payloadHash};
}
test("actual importer normalizes 260 tyś and persists Finder membership, metadata and history", async()=>{
  const owner=await ownership();const atomicContext={...context,sourceScanId:owner.sourceScanId};
  const result=await runAndroidDataOnlyImport(()=>importFacebookWatcher(input,atomicContext),owner);
  assert.equal(result.listingCreated,true); assert.ok(result.listingId);
  const row=await db.from("listings").select("price,area,source").eq("id",result.listingId).single();
  assert.equal(row.error,null); assert.equal(row.data?.price,260000); assert.equal(row.data?.area,50);assert.equal(row.data?.source,"facebook");
  for(const table of ["listing_source_metadata","listing_snapshots","listing_filter_matches"]) {
    const stored: { data: unknown[] | null; error: { message: string } | null } = await db.from(table).select("*").eq("listing_id",result.listingId);
    assert.equal(stored.error,null,table+": "+stored.error?.message);assert.equal(stored.data?.length,1,table);
  }
  const again=await runAndroidDataOnlyImport(()=>importFacebookWatcher(input,atomicContext),owner);
  assert.equal(again.listingId,result.listingId);assert.deepEqual(again.transactionalWrite,result.transactionalWrite);
  assert.deepEqual(result.transactionalWrite,{created:1,updated:0,duplicates:0});
  const history=await db.from("listing_snapshots").select("id").eq("listing_id",result.listingId);
  assert.equal(history.data?.length,1);
});
test("sale gate rejects rent and buy without creating Finder records",async()=>{
  for(const text of ["Wynajmę mieszkanie 50 m2 Łódź 2000 zł miesięcznie","Kupię mieszkanie w Łodzi do 300000 zł"]) {
    const result=await runAndroidDataOnlyImport(()=>importFacebookWatcher({...input,postText:text},context));
    assert.equal(result.status,"skipped");assert.equal(result.listingId,null);
  }
});
test("concurrent Android jobs count unchanged listings as duplicates exactly once per job",async()=>{
  const owners=await Promise.all([ownership(),ownership()]);
  const results=await Promise.all(owners.map(owner=>runAndroidDataOnlyImport(()=>importFacebookWatcher(input,{...context,sourceScanId:owner.sourceScanId}),owner)));
  assert.equal(results.reduce((sum,row)=>sum+(row.transactionalWrite?.created??-100),0),0);
  assert.equal(results.reduce((sum,row)=>sum+(row.transactionalWrite?.updated??-100),0),0);
  assert.equal(results.reduce((sum,row)=>sum+(row.transactionalWrite?.duplicates??-100),0),2);
  assert.equal(results[0].listingId,results[1].listingId);
});
test("failure after listing/history writes rolls back metadata, membership, counters and receipt; retry succeeds",async()=>{
  const owner=await ownership(),postId="876543210123456",url=`https://facebook.com/groups/synthetic-lodz/posts/${postId}`;
  const prepared={sourceScanId:owner.sourceScanId,postId,checkedAt:new Date().toISOString(),
    listing:{source:"facebook",external_listing_id:postId,original_url:url,normalized_url:url,title:"Synthetic transaction",description:"Synthetic only",price:500000,area:70,rooms:3,images:[],content_hash:"isolated-transaction",flip_score:50},
    metadata:{source_post_url:url,group_name:"Synthetic only",metadata:{postId,groupId:context.groupId}},
    decision:{bucket:"INVALID",reasons:[],missingFields:[]}};
  await assert.rejects(persistAndroidFinderPost(db,owner,prepared),/TRANSACTION_FAILED/);
  const absent=await db.from("listings").select("id").eq("source","facebook").eq("external_listing_id",postId);
  assert.equal(absent.error,null);assert.equal(absent.data?.length,0);
  const receipt=await db.from("android_facebook_post_receipts").select("*").eq("job_id",owner.jobId);
  assert.equal(receipt.data?.length,0);
  const saved=await persistAndroidFinderPost(db,owner,{...prepared,decision:{...prepared.decision,bucket:"REVIEW",missingFields:["city"]}});
  assert.equal(saved.created,1);assert.equal(saved.updated,0);assert.equal(saved.duplicates,0);
  const retry=await persistAndroidFinderPost(db,owner,{...prepared,decision:{...prepared.decision,bucket:"REVIEW",missingFields:["city"]}});
  assert.deepEqual(retry,saved);
});
test("atomic Finder RPC fences stale owners and another source",async()=>{
  const owner=await ownership();
  const prepared={sourceScanId:owner.sourceScanId,postId:"876543210123457",checkedAt:new Date().toISOString(),listing:{source:"olx"},metadata:{},decision:{bucket:"REVIEW",reasons:[],missingFields:[]}};
  await assert.rejects(persistAndroidFinderPost(db,owner,prepared),/TRANSACTION_FAILED/);
  await assert.rejects(persistAndroidFinderPost(db,{...owner,leaseToken:randomUUID()},prepared),/TRANSACTION_FAILED/);
});
test("two concurrent first imports produce one physical INSERT and one DUPLICATE",async()=>{
  const owners=await Promise.all([ownership(),ownership()]),postId="765432101234567";
  const raw={...input,url:`https://www.facebook.com/groups/synthetic-lodz/posts/${postId}/`,postText:"Sprzedam mieszkanie 95 m2, 4 pokoje, Łódź Widzew, blok z cegły. Cena 750000 zł. Właściciel."};
  const results=await Promise.all(owners.map(owner=>runAndroidDataOnlyImport(()=>importFacebookWatcher(raw,{...context,postId,sourceScanId:owner.sourceScanId}),owner)));
  assert.equal(results.reduce((n,r)=>n+(r.transactionalWrite?.created??-100),0),1);
  assert.equal(results.reduce((n,r)=>n+(r.transactionalWrite?.updated??-100),0),0);
  assert.equal(results.reduce((n,r)=>n+(r.transactionalWrite?.duplicates??-100),0),1);
  assert.equal(results[0].listingId,results[1].listingId);
  const history=await db.from("listing_snapshots").select("id").eq("listing_id",results[0].listingId);
  assert.equal(history.data?.length,1);
});
test("a price update is counted once; archived history is never reactivated by a later job",async()=>{
  const owner=await ownership();
  const result=await runAndroidDataOnlyImport(()=>importFacebookWatcher({...input,postText:input.postText.replace("260 tyś.","250 tyś.")},{...context,sourceScanId:owner.sourceScanId}),owner);
  assert.deepEqual(result.transactionalWrite,{created:0,updated:1,duplicates:0});assert.ok(result.listingId);
  const before=await db.from("listings").select("price,first_seen_at").eq("id",result.listingId).single();
  assert.equal(before.data?.price,250000);
  const archived=await db.from("listings").update({lifecycle_status:"ARCHIVED",archived_at:new Date().toISOString()}).eq("id",result.listingId);assert.equal(archived.error,null);
  const later=await ownership();
  const replay=await runAndroidDataOnlyImport(()=>importFacebookWatcher({...input,postText:input.postText.replace("260 tyś.","240 tyś.")},{...context,sourceScanId:later.sourceScanId}),later);
  assert.deepEqual(replay.transactionalWrite,{created:0,updated:0,duplicates:1});assert.equal(replay.matched,false);
  const row=await db.from("listings").select("price,first_seen_at,lifecycle_status").eq("id",result.listingId).single();
  assert.equal(row.data?.price,250000);assert.equal(row.data?.first_seen_at,before.data?.first_seen_at);assert.equal(row.data?.lifecycle_status,"ARCHIVED");
});
test("confirmed profile permalink is supported by the same atomic Finder RPC",async()=>{
  const owner=await ownership(true),postId="654321012345678",url=`https://facebook.com/123456/posts/${postId}`;
  const result=await persistAndroidFinderPost(db,owner,{sourceScanId:owner.sourceScanId,postId,checkedAt:new Date().toISOString(),
    listing:{source:"facebook",external_listing_id:postId,original_url:url,normalized_url:url,title:"Synthetic profile post",price:320000,area:40,images:[],content_hash:"synthetic-profile"},
    metadata:{source_post_url:url,metadata:{postId,groupId:"123456"}},decision:{bucket:"REVIEW",reasons:[],missingFields:["rooms"]}});
  assert.equal(result.created,1);
  const metadata=await db.from("listing_source_metadata").select("source_post_url").eq("listing_id",result.listingId).single();
  assert.equal(metadata.data?.source_post_url,url);
});
test("signed API recovers a real Finder post-commit failure after lease expiry and repeats without duplicates",async()=>{
  const path="/api/collector/android/jobs/complete",postId="543210123456789";
  const tokens=new Map<string,string>();
  async function completion(owner:AndroidFinderOwnership) {
    const token=randomUUID()+randomUUID();tokens.set(owner.deviceId,token);
    const key=await db.from("collector_devices").update({token_hash:collectorSigningKey(token)}).eq("id",owner.deviceId);assert.equal(key.error,null);
    const job=await db.from("facebook_scan_jobs").select("scan_run_id").eq("id",owner.jobId).single();assert.ok(job.data);
    const now=new Date().toISOString();
    const texts=["Sprzedam mieszkanie 120 m2, 5 pokoi, Łódź Widzew. Blok z cegły, cena 900000 zł. Bezpośrednio właściciel.","Wynajmę mieszkanie Łódź 2000 zł miesięcznie","Kupię mieszkanie w Łodzi do 300000 zł"];
    return JSON.stringify({jobId:owner.jobId,leaseToken:owner.leaseToken,completionId:owner.completionId,dataMode:"OFFLINE_TEST",status:"completed",batch:{
      scanId:job.data.scan_run_id,batchId:owner.completionId,sourceId:context.groupId,sourceType:"GROUP",sourceUrl:context.groupUrl,collectedAt:now,imageMode:"SOURCE_SCAN_DATA_ONLY",
      health:{status:"HEALTHY",visibleCardCount:3,capturedPostCount:3,scrolls:0,durationMs:0,stopReason:"NO_NEW_IDS",reasons:[]},
      posts:texts.map((text,index)=>({postId:String(BigInt(postId)+BigInt(index)),permalink:`https://www.facebook.com/groups/synthetic-lodz/posts/${BigInt(postId)+BigInt(index)}/`,sourceId:context.groupId,sourceType:"GROUP",text,author:"Synthetic owner",publishedAt:now,identityConfidence:"EXACT",media:[]})),
    }});
  }
  async function send(owner:AndroidFinderOwnership,body:string,nonce?:string) {
    const token=tokens.get(owner.deviceId);assert.ok(token);
    const auth=createCollectorAuthHeaders({deviceId:owner.deviceId,deviceToken:token,method:"POST",pathname:path,body,nonce});
    const request=new Request("https://offline.invalid"+path,{method:"POST",headers:{"content-type":"application/json","x-flip-collector-device-id":auth.deviceId,"x-flip-collector-timestamp":auth.timestamp,"x-flip-collector-nonce":auth.nonce,"x-flip-collector-signature":auth.signature},body});
    return handleAndroidRequest(request,"complete",{enabled:()=>true,expectedDataMode:"OFFLINE_TEST",atomicFinderImportReplay:true,store:androidJobStore,
      authenticate:async(request,pathname,body)=>{
        try{return (await authenticateSignedCollectorRequest({request,pathname,body,expectedConsumerType:"ANDROID_WEBVIEW",markHealthy:true})).device.id;}
        catch(error){if(error instanceof SignedCollectorAuthError)throw new AndroidJobError(error.status,error.code);throw error;}
      },
      processBatch:(deviceId,batch,ownerContext)=>runAndroidDataOnlyImport(()=>processFacebookCollectorBatch(deviceId,batch,{...ownerContext,qualityReport:true}),{...ownerContext,deviceId}),
    });
  }
  const owner=await ownership(false,false),body=await completion(owner);
  loseNextPostResponse=true;
  const first=await send(owner,body);assert.equal(first.status,503);
  const scan=await db.from("source_scans").select("status,listings_created").eq("id",owner.sourceScanId).single();
  assert.equal(scan.data?.status,"running");assert.equal(scan.data?.listings_created,0);
  const partial=await db.from("android_facebook_post_receipts").select("*").eq("job_id",owner.jobId);assert.equal(partial.data?.length,1);
  const expire=await db.from("facebook_scan_jobs").update({leased_until:new Date(Date.now()-1000).toISOString()}).eq("id",owner.jobId);assert.equal(expire.error,null);
  const recovered=await send(owner,body);assert.equal(recovered.status,200);const receipt=await recovered.json();
  assert.deepEqual(receipt.result.writeAccounting,{version:1,basis:"TRANSACTIONAL",created:1,updated:0,duplicates:0});assert.equal(receipt.result.skipped,2);
  const replay=await send(owner,body);assert.deepEqual(await replay.json(),receipt);
  const next=await ownership(false,false),nextBody=await completion(next),repeat=await send(next,nextBody);assert.equal(repeat.status,200);
  const repeated=await repeat.json();assert.deepEqual(repeated.result.writeAccounting,{version:1,basis:"TRANSACTIONAL",created:0,updated:0,duplicates:1});assert.equal(repeated.result.skipped,2);
  const rows=await db.from("listings").select("id").eq("source","facebook").eq("external_listing_id",postId);assert.equal(rows.data?.length,1);
  const nonce="full_schema_replay_nonce_000001";
  assert.equal((await send(next,nextBody,nonce)).status,200);assert.equal((await send(next,nextBody,nonce)).status,401);
});
test("real RLS and grants deny anonymous listing writes and Android RPCs",async()=>{
  const anon=createClient("http://127.0.0.1:55442",jwt("anon"),{global:{fetch:gateway},auth:{persistSession:false,autoRefreshToken:false}});
  const denied=await anon.from("listings").insert({source:"facebook",external_listing_id:"forbidden",original_url:input.url});
  assert.ok(denied.error);
  const rpc=await anon.rpc("claim_android_facebook_scan_job",{p_device_id:"00000000-0000-4000-8000-000000000001",p_lease_seconds:180});assert.ok(rpc.error);
  const begin=await anon.rpc("begin_android_facebook_finder_completion",{p_job_id:randomUUID(),p_device_id:randomUUID(),p_lease_token:randomUUID(),p_completion_id:randomUUID(),p_payload_hash:"a".repeat(64)});assert.ok(begin.error);
});
test("new recovery capability never upgrades an ambiguous legacy reservation",async()=>{
  const owner=await ownership(false,false);
  const args={p_job_id:owner.jobId,p_device_id:owner.deviceId,p_lease_token:owner.leaseToken,p_completion_id:owner.completionId,p_payload_hash:owner.payloadHash};
  const legacy=await db.rpc("begin_android_facebook_completion",args);assert.equal(legacy.data?.outcome,"reserved");
  const refused=await db.rpc("begin_android_facebook_finder_completion",args);assert.equal(refused.data?.outcome,"legacy");
  const row=await db.from("facebook_scan_jobs").select("android_finder_write_version").eq("id",owner.jobId).single();assert.equal(row.data?.android_finder_write_version,0);
});
test("Finder import never inserts OLX jobs or changes OLX automation",async()=>{
  for(const table of ["olx_scan_jobs","finder_olx_slots","olx_automation_control","price_radar_runs"]) {
    const result=await db.from(table).select("*",{count:"exact",head:true});
    assert.equal(result.error,null);assert.equal(result.count,0,table);
  }
});
