import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { handleAndroidRequest, type AndroidAction } from "./handler.ts";
import { MockAndroidStore, jobRow, DEVICE, RUN } from "./fixtures.test-support.ts";
import { createCollectorAuthHeaders, collectorSigningKey, verifyCollectorAuth } from "../protocol.ts";
import { normalizeFacebookCollectorBatch } from "../facebook-batch.ts";
import { extractFacebookProperty } from "../../facebook-watcher/extract-facebook-property.ts";
import { resolveFacebookListingIntent } from "../../facebook-watcher/facebook-intent.ts";

test("13-source signed API simulation recovers leases, response loss and cancellation without mixing sources", async () => {
  const jobs=Array.from({length:13},(_,index)=>{
    const profile=index>=11;const sourceId=profile?String(123456+index):`offline-${index}`;
    return jobRow({id:randomUUID(),source_scan_id:randomUUID(),status:"queued",worker_id:"",attempts:0,
      group_snapshot:[{id:randomUUID(),name:`Source ${index}`,sourceId,type:profile?"PROFILE":"GROUP",url:profile?`https://www.facebook.com/profile.php?id=${sourceId}`:`https://www.facebook.com/groups/${sourceId}/`}]});
  });
  const browser=jobRow({id:randomUUID(),consumer_type:"BROWSER_EXTENSION",status:"queued",attempts:0});
  const store=new MockAndroidStore([...jobs,browser]); const nonces=new Set<string>();
  const listings=new Map<string,{sourceId:string;price:number|null}>();let imports=0;let responseLoss=false;let expired=false;let cycles=1;let budget=0;
  const deps={enabled:()=>true,store:()=>store,
    authenticate:async(request:Request,path:string,body:string)=>{
      const auth=await verifyCollectorAuth({signingKey:collectorSigningKey("offline-mock-token"),method:"POST",pathname:path,body,headers:request.headers,useNonce:async nonce=>{if(nonces.has(nonce))return false;nonces.add(nonce);return true;}});
      assert.equal(auth.ok,true);return DEVICE;
    },
    processBatch:async(_device:string,batch:ReturnType<typeof normalizeFacebookCollectorBatch>)=>{
      imports++;for(const post of batch.posts){
        assert.equal(post.sourceId,batch.sourceId);
        if(post.identityConfidence!=="EXACT"||resolveFacebookListingIntent(post.text,null,null).intent!=="SELL_PROPERTY")continue;
        const property=await extractFacebookProperty({postText:post.text,images:[]});
        const old=listings.get(post.postId);assert.ok(!old||old.sourceId===batch.sourceId);
        listings.set(post.postId,{sourceId:batch.sourceId,price:property.price});
      }return {status:"completed"};
    }};
  async function send(action:AndroidAction,value:unknown){
    const body=JSON.stringify(value);const path=`/api/collector/android/jobs/${action}`;
    const auth=createCollectorAuthHeaders({deviceId:DEVICE,deviceToken:"offline-mock-token",method:"POST",pathname:path,body});
    return handleAndroidRequest(new Request("https://example.invalid"+path,{method:"POST",body,headers:{"content-type":"application/json","x-flip-collector-device-id":auth.deviceId,"x-flip-collector-timestamp":auth.timestamp,"x-flip-collector-nonce":auth.nonce,"x-flip-collector-signature":auth.signature}}),action,deps);
  }
  for(let iteration=0;iteration<30&&jobs.some(j=>!["completed","failed"].includes(j.status));iteration++){
    if(budget+75_000>480_000){cycles++;budget=0;}
    const response=await send("claim",{});assert.equal(response.status,200);const {job}=await response.json();
    if(!job){store.now+=30_000;continue;}
    const index=jobs.findIndex(row=>row.id===job.id);const row=jobs[index];const completionId=randomUUID();
    if(index===2&&!expired){expired=true;store.now+=180_001;const lost=await send("heartbeat",{jobId:job.id,leaseToken:job.leaseToken});assert.equal(lost.status,409);continue;}
    assert.equal((await send("heartbeat",{jobId:job.id,leaseToken:job.leaseToken})).status,200);
    let value:unknown;
    if(index===12)value={jobId:job.id,leaseToken:job.leaseToken,completionId,dataMode:"LIVE",status:"failed",errorCode:"SOURCE_UNAVAILABLE"};
    else if(index===4)value={jobId:job.id,leaseToken:job.leaseToken,completionId,dataMode:"LIVE",status:"cancelled"};
    else {
      const postId=String(100000000000+index);const permalink=job.group.type==="GROUP"?job.group.url+`posts/${postId}/`:`https://www.facebook.com/${job.group.sourceId}/posts/${postId}/`;
      const post={postId,permalink,sourceId:job.group.sourceId,sourceType:job.group.type,author:"Offline Author",text:"Sprzedam mieszkanie 42 m2, 2 pokoje, Łódź Retkinia, 260 tyś.",identityConfidence:"EXACT",publishedAt:"2026-10-15T00:00:00Z",media:[]};
      value={jobId:job.id,leaseToken:job.leaseToken,completionId,dataMode:"LIVE",status:"completed",batch:{scanId:RUN,batchId:completionId,sourceId:job.group.sourceId,sourceType:job.group.type,sourceUrl:job.group.url,collectedAt:new Date().toISOString(),imageMode:"SOURCE_SCAN_DATA_ONLY",health:{status:"HEALTHY",visibleCardCount:index===3?0:2,capturedPostCount:index===3?0:1,scrolls:0,durationMs:60_000,stopReason:"NO_NEW_IDS",reasons:[]},posts:index===3?[]:[post,post]}};
    }
    if(index===0) normalizeFacebookCollectorBatch((value as {batch:unknown}).batch);
    const done=await send("complete",value);const receipt=await done.json();assert.equal(done.status,200,JSON.stringify({index,receipt}));
    if(!responseLoss){responseLoss=true;const before=imports;const retry=await send("complete",value);assert.deepEqual(await retry.json(),receipt);assert.equal(imports,before);}
    assert.ok(["completed","failed"].includes(row.status));budget+=60_000;
  }
  assert.equal(jobs.filter(j=>["completed","failed"].includes(j.status)).length,13);
  assert.equal(listings.size,10);assert.equal(imports,11);assert.equal(browser.attempts,0);
  assert.ok(cycles>=2);assert.ok(expired&&responseLoss);assert.ok([...listings.values()].every(row=>row.price===260000));
});
