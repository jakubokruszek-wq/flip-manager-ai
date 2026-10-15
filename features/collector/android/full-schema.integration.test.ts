/** Actual Watcher -> Finder orchestration over PostgREST and native PostgreSQL.
 * Only the admin-client factory is substituted. No persistence/normalization RPC is mocked. */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHmac, randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAndroidDataOnlyImport, type AndroidFinderOwnership } from "./import-policy.ts";
import { persistAndroidFinderPost } from "./finder-write.ts";
if (process.env.GITHUB_ACTIONS !== "true" && process.env.FLIP_ISOLATED_TESTS !== "1") throw Error("ISOLATED_TESTS_ONLY");
const secret="isolated-full-schema-postgrest-signing-key-only";
function jwt(role: string) {
  const head=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const body=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  return head+"."+body+"."+createHmac("sha256",secret).update(head+"."+body).digest("base64url");
}
const db=createClient("http://127.0.0.1:55442",jwt("service_role"),{auth:{persistSession:false,autoRefreshToken:false}});
mock.module("@/features/facebook-watcher/supabase-admin",{namedExports:{createFacebookWatcherAdminClient:()=>db}});
const {importFacebookWatcher}=await import("../../facebook-watcher/server.ts");
const {getSearchFilter}=await import("../../flip-finder/server/search-filters.ts");
const filter=await getSearchFilter("66666666-6666-4666-8666-666666666666",{supabase:db});
assert.ok(filter);
const context={filter,sourceScanId:"44444444-4444-4444-8444-444444444444",groupId:"synthetic-lodz",groupName:"Synthetic only",groupUrl:"https://www.facebook.com/groups/synthetic-lodz/",postId:"987654321012345",checkedAt:new Date().toISOString(),imageMode:"SEARCH_DATA_FIRST" as const};
const input={url:"https://www.facebook.com/groups/synthetic-lodz/posts/987654321012345/",postText:"Sprzedam mieszkanie 50 m2, 2 pokoje, Łódź Bałuty, w bloku z cegły. Cena 260 tyś. zł. Bezpośrednio właściciel.",images:[]};
async function ownership(): Promise<AndroidFinderOwnership> {
  const deviceId=randomUUID(),jobId=randomUUID(),sourceScanId=randomUUID(),completionId=randomUUID(),runId=randomUUID();
  const payloadHash=createHash("sha256").update(completionId).digest("hex");
  const groupId="00000000-0000-4000-8000-000000000008";
  for(const result of [
    await db.from("collector_devices").insert({id:deviceId,device_name:"Synthetic test",installation_id:deviceId,token_hash:"synthetic-only",consumer_type:"ANDROID_WEBVIEW"}),
    await db.from("watched_facebook_groups").upsert({id:groupId,name:"Synthetic only",url:context.groupUrl,enabled:true,access_status:"CONNECTED"}),
    await db.from("source_scans").insert({id:sourceScanId,search_filter_id:context.filter.id,source:"facebook",status:"running",scan_run_id:runId,filter_snapshot:context.filter}),
    await db.from("collector_android_source_grants").insert({device_id:deviceId,watched_group_id:groupId,search_filter_id:context.filter.id}),
    await db.from("facebook_scan_jobs").insert({id:jobId,scan_run_id:runId,source_scan_id:sourceScanId,search_filter_id:context.filter.id,consumer_type:"ANDROID_WEBVIEW",idempotency_key:jobId,
      group_snapshot:[{id:groupId,name:context.groupName,url:context.groupUrl,sourceId:context.groupId,type:"GROUP"}]})
  ]) assert.equal(result.error,null,result.error?.message);
  const claimed=await db.rpc("claim_android_facebook_scan_job",{p_device_id:deviceId,p_lease_seconds:180});
  assert.equal(claimed.error,null);const lease:unknown=claimed.data;
  assert.ok(Array.isArray(lease) && lease.length===1 && typeof lease[0].lease_token==="string");
  const leaseToken=String(lease[0].lease_token);
  const begun=await db.rpc("begin_android_facebook_completion",{p_job_id:jobId,p_device_id:deviceId,p_lease_token:leaseToken,p_completion_id:completionId,p_payload_hash:payloadHash});
  assert.equal(begun.error,null);assert.equal(begun.data?.outcome,"reserved");
  return {jobId,deviceId,sourceScanId,completionId,leaseToken,payloadHash};
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
    metadata:{source_post_url:url,group_name:"Synthetic only",metadata:{postId}},
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
test("real RLS and grants deny anonymous listing writes and Android RPCs",async()=>{
  const anon=createClient("http://127.0.0.1:55442",jwt("anon"),{auth:{persistSession:false,autoRefreshToken:false}});
  const denied=await anon.from("listings").insert({source:"facebook",external_listing_id:"forbidden",original_url:input.url});
  assert.ok(denied.error);
  const rpc=await anon.rpc("claim_android_facebook_scan_job",{p_device_id:"00000000-0000-4000-8000-000000000001",p_lease_seconds:180});assert.ok(rpc.error);
});
test("Finder import never inserts OLX jobs or changes OLX automation",async()=>{
  for(const table of ["olx_scan_jobs","finder_olx_slots","olx_automation_control","price_radar_runs"]) {
    const result=await db.from(table).select("*",{count:"exact",head:true});
    assert.equal(result.error,null);assert.equal(result.count,0,table);
  }
});
