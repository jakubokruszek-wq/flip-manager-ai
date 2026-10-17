import assert from "node:assert/strict";
import test from "node:test";
import { persistAndroidFinderPost } from "./finder-write.ts";
const id="00000000-0000-4000-8000-000000000001";
const owner={jobId:id,deviceId:id,sourceScanId:id,leaseToken:id,completionId:id,payloadHash:"a".repeat(64)};
const input={sourceScanId:id,postId:"123456789012345",listing:{source:"facebook"},metadata:{},decision:{bucket:"REVIEW",reasons:[],missingFields:["price"]},checkedAt:new Date().toISOString()};
const valid={listingId:id,created:1,updated:0,duplicates:0,matched:false,matchCreated:false,priceDrop:0};
test("atomic Finder boundary binds the reserved context and validates physical write witness",async()=>{
  let args:Record<string,unknown>|undefined;
  const db={rpc:async(name:string,value:Record<string,unknown>)=>{assert.equal(name,"persist_android_facebook_finder_post");args=value;return{data:valid,error:null};}};
  assert.deepEqual(await persistAndroidFinderPost(db,owner,input),valid);
  assert.equal(args?.p_payload_hash,owner.payloadHash);assert.equal(args?.p_lease_token,owner.leaseToken);
  await assert.rejects(persistAndroidFinderPost(db,owner,{...input,sourceScanId:"other"}),/CONTEXT_INVALID/);
});
test("atomic Finder boundary rejects null, ambiguous and inflated operation counters",async()=>{
  for(const data of [null,[],{...valid,created:2},{...valid,updated:1},{...valid,priceDrop:1},{...valid,matchCreated:true},{...valid,listingId:"-".repeat(36)}])
    await assert.rejects(persistAndroidFinderPost({rpc:async()=>({data,error:null})},owner,input),/RECEIPT_INVALID/);
});
test("database failures expose a bounded code without leaking database payloads",async()=>{
  await assert.rejects(persistAndroidFinderPost({rpc:async()=>({data:null,error:{code:"42501"}})},owner,input),error=>error instanceof Error && error.message==="ANDROID_FINDER_TRANSACTION_FAILED" && error.cause==="42501");
});
