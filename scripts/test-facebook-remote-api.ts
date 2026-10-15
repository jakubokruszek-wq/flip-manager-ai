/** Local CI proof of the remote ingress/auth mode. No remote deployment. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as proxyRequest } from "node:http";
import { collectorSigningKey, createCollectorAuthHeaders } from "../features/collector/protocol.ts";
if(process.env.GITHUB_ACTIONS!=="true" && process.env.FLIP_ISOLATED_TESTS!=="1")throw Error("ISOLATED_TESTS_ONLY");
const origin="https://watcher-test.example.org",deviceId="00000000-0000-4000-8000-000000000001";
const token=randomBytes(32).toString("base64url");
const children:ChildProcess[]=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// Simulate the trusted HTTPS proxy on loopback. Fetch implementations may
// replace the Host header, so send an actual HTTP/1 request with that header.
function viaProxy(url:string,init:{method?:string;headers:Record<string,string>;body?:string;signal?:AbortSignal}):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const req=proxyRequest(url,{method:init.method??"GET",headers:init.headers,signal:init.signal},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){req.destroy(Error("ISOLATED_RESPONSE_TOO_LARGE"));return;}chunks.push(chunk);});
      res.on("end",()=>resolve(new Response(Buffer.concat(chunks).toString("utf8"),{status:res.statusCode??500})));
      res.on("error",reject);
    });req.on("error",reject);req.end(init.body);
  });
}
async function shutdown(child:ChildProcess) {
  if(child.exitCode!==null || child.signalCode!==null)return;
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
  child.kill("SIGTERM"); const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try{await exited;}finally{clearTimeout(timer);}
}
test("remote OFFLINE_TEST ingress keeps signed sources, claim, checkpoint and replay isolated",async()=>{
  try {
    children.push(spawn("python",["scripts/facebook-android-test-db.py"],{env:{...process.env,FLIP_OFFLINE_REMOTE_TEST:"false"},stdio:"ignore"}));
    let ready=false;
    for(let n=0;n<30;n++){
      if(children[0].exitCode!==null)throw Error("ISOLATED_BRIDGE_START_FAILED");
      try{const r=await fetch("http://127.0.0.1:55440/health",{method:"POST",body:"{}",signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
      await sleep(500);
    }
    assert.equal(ready,true);
    children.push(spawn("node",["--import","./scripts/test-alias-loader.mjs","scripts/facebook-android-test-api.ts"],{env:{...process.env,FLIP_OFFLINE_REMOTE_TEST:"true",FLIP_OFFLINE_TEST_ORIGIN:origin,FLIP_OFFLINE_DEVICE_SIGNING_KEY:collectorSigningKey(token),FLIP_OFFLINE_TEST_EXPIRES_AT:String(Date.now()+3600_000),PORT:"55443"},stdio:"ignore"}));
    const headers={host:new URL(origin).host,"x-forwarded-proto":"https","content-type":"application/json"};
    const url="http://127.0.0.1:55443";
    ready=false;
    for(let n=0;n<30;n++){
      if(children[1].exitCode!==null)throw Error("ISOLATED_API_START_FAILED");
      try{const r=await viaProxy(url+"/healthz",{headers,signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
      await sleep(500);
    }
    assert.equal(ready,true);
    async function signed(path:string,body="{}",nonce?:string){
      const auth=createCollectorAuthHeaders({deviceId,deviceToken:token,method:"POST",pathname:path,body,nonce});
      return viaProxy(url+path,{method:"POST",headers:{...headers,"x-flip-collector-device-id":deviceId,"x-flip-collector-timestamp":auth.timestamp,"x-flip-collector-nonce":auth.nonce,"x-flip-collector-signature":auth.signature},body});
    }
    for(const path of ["/__test/stats","/__test/requeue","/__test/fail-next-import"])assert.equal((await viaProxy(url+path,{headers})).status,404);
    assert.equal((await viaProxy(url+"/healthz",{headers:{...headers,host:"flip-manager-ai.vercel.app"}})).status,421);
    assert.equal((await viaProxy(url+"/api/collector/android/sources/sync",{method:"POST",headers,body:"{}"})).status,401);
    const syncPath="/api/collector/android/sources/sync",nonce="synthetic_remote_nonce_000001";
    const response=await signed(syncPath,"{}",nonce);assert.equal(response.status,200);
    const sources=await response.json();assert.equal(sources.sources.length,13);assert.equal(sources.sources.filter((s:{type:string})=>s.type==="GROUP").length,11);
    assert.equal((await signed(syncPath,"{}",nonce)).status,401);
    const claim=await signed("/api/collector/android/jobs/claim",JSON.stringify({sourceIds:[sources.sources[0].id]}));
    assert.equal(claim.status,200);const {job}=await claim.json();assert.ok(job);
    const completionId=crypto.randomUUID();
    const body=JSON.stringify({jobId:job.id,leaseToken:job.leaseToken,completionId,status:"completed",dataMode:"OFFLINE_TEST",batch:{scanId:job.runId,batchId:completionId,sourceId:job.group.sourceId,sourceType:job.group.type,sourceUrl:job.group.url,collectedAt:new Date().toISOString(),imageMode:"SOURCE_SCAN_DATA_ONLY",health:{status:"HEALTHY",visibleCardCount:0,capturedPostCount:0,scrolls:0,durationMs:0,stopReason:"NO_NEW_IDS",reasons:[]},posts:[]}});
    const complete=await signed("/api/collector/android/jobs/complete",body);assert.equal(complete.status,200);const receipt=await complete.json();assert.equal(receipt.status,"completed");
    const retry=await signed("/api/collector/android/jobs/complete",body);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),receipt);
    assert.deepEqual(receipt.result.writeAccounting,{version:1,basis:"TRANSACTIONAL",created:0,updated:0,duplicates:0});
  }finally{for(const child of children.reverse())await shutdown(child);}
});
