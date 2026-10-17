/** CI-only isolated API: actual HMAC/handlers/normalizers, PostgreSQL via a
 * loopback bridge. Never imports Supabase admin clients or production secrets.
 * The persistence adapter is a test schema, not the full Finder persistence. */
import https from "node:https";
import http from "node:http";
import { remoteOfflineTestConfig } from "../features/collector/android/offline-test-config.ts";
import { livePilotIngressConfig, livePilotStore, assertPilotBatch, validatePilotCompletion } from "../features/collector/android/live-pilot-ingress.ts";
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

if (process.env.GITHUB_ACTIONS !== "true" && process.env.FLIP_ISOLATED_TESTS !== "1") throw Error("ISOLATED_TESTS_ONLY");
const remote = remoteOfflineTestConfig(process.env);
const pilot = livePilotIngressConfig(process.env, remote);
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
  if(remote && Date.now() >= remote.expiresAt) throw new AndroidJobError(401,"OFFLINE_TEST_EXPIRED");
  const requestedDevice=request.headers.get("x-flip-collector-device-id");
  const isPilot=pilot!=null && requestedDevice===pilot.deviceId;
  if(requestedDevice!==DEVICE && !isPilot)throw new AndroidJobError(401,"INVALID_DEVICE");
  if(isPilot && Date.now()>=pilot!.expiresAt)throw new AndroidJobError(401,"PILOT_APPROVAL_EXPIRED");
  const auth=await verifyCollectorAuth({signingKey:isPilot ? pilot!.signingKey : remote?.signingKey ?? collectorSigningKey("isolated-ci-device-token"),method:request.method,pathname,body,headers:request.headers,
    useNonce:async nonce=>(await db("/nonce",{deviceId:requestedDevice,nonce}) as {accepted:boolean}).accepted});
  if(!auth.ok)throw new AndroidJobError(401,auth.code);
  if(isPilot && pathname.endsWith("/complete")) validatePilotCompletion(body,pilot!);
  return requestedDevice!;
}
let failNextImport = false;
async function processBatch(deviceId:string,batch:FacebookCollectorBatch,context:{sourceScanId:string}) {
  if(pilot && deviceId===pilot.deviceId) assertPilotBatch(batch,pilot);
  if(failNextImport) { failNextImport=false; throw Error("ISOLATED_PRE_TRANSACTION_FAILURE"); }
  const listings:{postId:string;sourceId:string;price:number|null}[]=[];
  const outcomes:FacebookPostOutcome[]=[];
  const pilotProperties:{postId:string;property:Awaited<ReturnType<typeof extractFacebookProperty>>}[]=[];
  for(const post of batch.posts){
    const intent=resolveFacebookListingIntent(post.text,null,null).intent;
    if(post.identityConfidence!=="EXACT"){outcomes.push({postId:post.postId,primaryOutcome:"IDENTITY_UNVERIFIED",reasonCodes:["identity_unverified"]});continue;}
    if(intent!=="SELL_PROPERTY"){outcomes.push({postId:post.postId,primaryOutcome:intent==="RENT_OFFER"?"RENTAL":"NON_SALE",reasonCodes:["non_sale"]});continue;}
    const extracted=await extractFacebookProperty({postText:post.text ?? undefined,images:[]});
    if(pilot && deviceId===pilot.deviceId)pilotProperties.push({postId:post.postId,property:extracted});
    listings.push({postId:post.postId,sourceId:post.sourceId,price:extracted.price});
    outcomes.push({postId:post.postId,primaryOutcome:"REVIEW",reasonCodes:[]});
  }
  const binding={deviceId,batchId:batch.batchId,runId:batch.scanId,sourceScanId:context.sourceScanId,sourceId:batch.sourceId,sourceUrl:batch.sourceUrl};
  return await db("/import",{binding,listings,result:{status:"completed",batchId:batch.batchId,captured:batch.posts.length,skipped:batch.posts.length-listings.length,errors:0,sourceScanIds:[context.sourceScanId],accounting:aggregateFacebookScanAccounting(outcomes,batch.posts.length),quality:buildFacebookBatchQuality(batch,outcomes,new Set()),
    // Private evidence in the existing RLS-protected test checkpoint only.
    // Never sent to Finder, public metadata, logs or anonymized diagnostics.
    ...(pilot && deviceId===pilot.deviceId ? {dataMode:"LIVE_PILOT",pilotEvidence:{sourceId:batch.sourceId,sourceUrl:batch.sourceUrl,posts:batch.posts,properties:pilotProperties}} : {})}}) as {status:string};
}
const jobs=new Set(["claim","heartbeat","complete","status"]);
const metadata=new Set(["sources/sync","device/status","diagnostics"]);
const listener: http.RequestListener=async(req,res)=>{
  try{
    const path=new URL(req.url??"/","https://localhost").pathname;
    if(remote && (req.headers.host!==new URL(remote.origin).host || req.headers["x-forwarded-proto"]!=="https")) {res.writeHead(421);res.end();return;}
    if(remote && path==="/healthz") {res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end('{"ok":true,"dataMode":"OFFLINE_TEST"}');return;}
    if(remote && path.startsWith("/__test/")) { res.writeHead(404); res.end(); return; }
    if(path==="/__test/health"){res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');return;}
    if(path==="/__test/stats"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(await db("/stats",{})));return;}
    if(path==="/__test/requeue" && req.method==="POST"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(await db("/requeue",{})));return;}
    if(path==="/__test/fail-next-import" && req.method==="POST"){failNextImport=true;res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');return;}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const headers=new Headers(); for(const [key,value] of Object.entries(req.headers)) if(value!==undefined) headers.set(key,Array.isArray(value)?value.join(","):value);
    const request=new Request("https://localhost"+path,{method:req.method,headers,body:Buffer.concat(chunks).toString("utf8")});
    const action=path.replace("/api/collector/android/jobs/","");
    const meta=path.replace("/api/collector/android/","");
    const isPilot=pilot!=null && request.headers.get("x-flip-collector-device-id")===pilot.deviceId;
    let result:Response;
    if(jobs.has(action)) result=await handleAndroidRequest(request,action as AndroidAction,{enabled:()=>true,expectedDataMode:isPilot?"LIVE":"OFFLINE_TEST",
      atomicOfflineImportReplay:!isPilot,
      // The existing checkpoint transaction supports exact replay in either domain.
      // This capability is local to the test sink; no production flag/importer is loaded.
      atomicPilotImportReplay:isPilot,authenticate,store:()=>isPilot?livePilotStore(store,pilot!):store,processBatch});
    else if(metadata.has(meta) && !isPilot) result=await handleAndroidMetadata(request,meta as AndroidMetadataAction,{enabled:()=>true,authenticate,store:()=>store,loadSources:async deviceId=>await db("/sources",{deviceId}) as AndroidSourceRow[]});
    else result=Response.json({ok:false,code:"NOT_FOUND"},{status:404});
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch{res.writeHead(503,{"content-type":"application/json"});res.end('{"ok":false,"code":"ISOLATED_API_FAILURE"}');}
};
const server=remote ? http.createServer(listener) : https.createServer({key:fs.readFileSync(process.env.FLIP_TEST_TLS_KEY!),cert:fs.readFileSync(process.env.FLIP_TEST_TLS_CERT!)},listener);
server.requestTimeout=30_000;server.headersTimeout=15_000;server.keepAliveTimeout=5_000;server.maxConnections=32;server.maxRequestsPerSocket=20;
const port=remote ? Number(process.env.PORT??10000) : 55441;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error("OFFLINE_TEST_PORT_INVALID");
server.listen(port,remote ? "0.0.0.0" : "127.0.0.1",()=>process.stdout.write("Isolated test API ready\n"));
