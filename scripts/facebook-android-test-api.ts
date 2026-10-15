/** CI-only isolated API: actual HMAC/handlers/normalizers, PostgreSQL via a
 * loopback bridge. Never imports Supabase admin clients or production secrets.
 * The persistence adapter is a test schema, not the full Finder persistence. */
import https from "node:https";
import fs from "node:fs";
import { handleAndroidRequest, type AndroidAction } from "../features/collector/android/handler.ts";
import { handleAndroidMetadata, type AndroidMetadataAction, type AndroidSourceRow } from "../features/collector/android/metadata.ts";
import { AndroidJobError, type AndroidJobRow, type AndroidJobStore } from "../features/collector/android/jobs.ts";
import { collectorSigningKey, verifyCollectorAuth } from "../features/collector/protocol.ts";
import type { FacebookCollectorBatch } from "../features/collector/facebook-batch.ts";
import { extractFacebookProperty } from "../features/facebook-watcher/extract-facebook-property.ts";
import { resolveFacebookListingIntent } from "../features/facebook-watcher/facebook-intent.ts";
import { aggregateFacebookScanAccounting, type FacebookPostOutcome } from "../features/facebook-worker/scan-accounting.ts";
import { buildFacebookBatchQuality } from "../features/collector/android/quality.ts";

if (process.env.GITHUB_ACTIONS !== "true") throw Error("ISOLATED_CI_ONLY");
const DEVICE="00000000-0000-4000-8000-000000000001";
async function db(path: string, body: unknown): Promise<unknown> {
  const result=await fetch("http://127.0.0.1:55440"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  if(!result.ok) throw Error("ISOLATED_DATABASE_UNAVAILABLE");
  return result.json();
}
const store: AndroidJobStore={
  rpc:async(name,args)=>({data:await db("/rpc",{name,args}),error:null}),
  loadJob:async id=>await db("/job",{id}) as AndroidJobRow|null,
  loadCompletedBatch:async binding=>await db("/checkpoint",binding) as {status:string}|null,
};
async function authenticate(request: Request, pathname: string, body: string) {
  if(request.headers.get("x-flip-collector-device-id")!==DEVICE)throw new AndroidJobError(401,"INVALID_DEVICE");
  const auth=await verifyCollectorAuth({signingKey:collectorSigningKey("isolated-ci-device-token"),method:request.method,pathname,body,headers:request.headers,
    useNonce:async nonce=>(await db("/nonce",{deviceId:DEVICE,nonce}) as {accepted:boolean}).accepted});
  if(!auth.ok)throw new AndroidJobError(401,auth.code);
  return DEVICE;
}
async function processBatch(deviceId:string,batch:FacebookCollectorBatch,context:{sourceScanId:string}) {
  const listings:{postId:string;sourceId:string;price:number|null}[]=[];
  const outcomes:FacebookPostOutcome[]=[];
  for(const post of batch.posts){
    const intent=resolveFacebookListingIntent(post.text,null,null).intent;
    if(post.identityConfidence!=="EXACT"){outcomes.push({postId:post.postId,primaryOutcome:"IDENTITY_UNVERIFIED",reasonCodes:["identity_unverified"]});continue;}
    if(intent!=="SELL_PROPERTY"){outcomes.push({postId:post.postId,primaryOutcome:intent==="RENT_OFFER"?"RENTAL":"NON_SALE",reasonCodes:["non_sale"]});continue;}
    const extracted=await extractFacebookProperty({postText:post.text,images:[]});
    listings.push({postId:post.postId,sourceId:post.sourceId,price:extracted.price});
    outcomes.push({postId:post.postId,primaryOutcome:"REVIEW",reasonCodes:[]});
  }
  const binding={deviceId,batchId:batch.batchId,runId:batch.scanId,sourceScanId:context.sourceScanId,sourceId:batch.sourceId,sourceUrl:batch.sourceUrl};
  return await db("/import",{binding,listings,result:{status:"completed",batchId:batch.batchId,captured:batch.posts.length,errors:0,sourceScanIds:[context.sourceScanId],accounting:aggregateFacebookScanAccounting(outcomes,batch.posts.length),quality:buildFacebookBatchQuality(batch,outcomes,new Set())}}) as {status:string};
}
const jobs=new Set(["claim","heartbeat","complete","status"]);
const metadata=new Set(["sources/sync","device/status","diagnostics"]);
const server=https.createServer({key:fs.readFileSync(process.env.FLIP_TEST_TLS_KEY!),cert:fs.readFileSync(process.env.FLIP_TEST_TLS_CERT!)},async(req,res)=>{
  try{
    const path=new URL(req.url??"/","https://localhost").pathname;
    if(path==="/__test/health"){res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');return;}
    if(path==="/__test/stats"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(await db("/stats",{})));return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const headers=new Headers(); for(const [key,value] of Object.entries(req.headers)) if(value!==undefined) headers.set(key,Array.isArray(value)?value.join(","):value);
    const request=new Request("https://localhost"+path,{method:req.method,headers,body:Buffer.concat(chunks).toString("utf8")});
    const action=path.replace("/api/collector/android/jobs/","");
    const meta=path.replace("/api/collector/android/","");
    let result:Response;
    if(jobs.has(action)) result=await handleAndroidRequest(request,action as AndroidAction,{enabled:()=>true,expectedDataMode:"OFFLINE_TEST",authenticate,store:()=>store,processBatch});
    else if(metadata.has(meta)) result=await handleAndroidMetadata(request,meta as AndroidMetadataAction,{enabled:()=>true,authenticate,store:()=>store,loadSources:async deviceId=>await db("/sources",{deviceId}) as AndroidSourceRow[]});
    else result=Response.json({ok:false,code:"NOT_FOUND"},{status:404});
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch{res.writeHead(503,{"content-type":"application/json"});res.end('{"ok":false,"code":"ISOLATED_API_FAILURE"}');}
});
server.listen(55441,"127.0.0.1",()=>process.stdout.write("Isolated HTTPS test API ready on loopback:55441\n"));
