import { test } from "node:test";
import assert from "node:assert/strict";
import { createMobileScanPost, parseMobileScan } from "./facebook-mobile-scan.ts";
const body=()=>({version:1,batchId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",scanId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",cycle:"capture-2/2026-11-04/1200",groupId:"297408205383031",appVersion:"0.5.77-gecko-poc",versionCode:8579,issue:"SALE_PHOTO_MISSING",interactive:false,idle:false,batteryExempt:true,stats:{scrollMoves:12,pageVisible:1},posts:[{postId:"1655103482946823",intent:"SELL_PROPERTY",qualification:"CANDIDATE",photos:0}]});
test("accepts bounded numeric reader evidence and rejects business data and impossible counters",()=>{
 assert.ok(parseMobileScan(body()));
 for(const bad of [{...body(),text:"private post"},{...body(),stats:{url:"https://fb/"}},{...body(),posts:Array(51).fill(body().posts[0])},{...body(),stats:{scrollMoves:-1}},{...body(),posts:[{...body().posts[0],jpeg:"image"}]}])assert.equal(parseMobileScan(bad),null);
});
test("authenticates before reading, verifies enabled source and stores only authenticated device",async()=>{
 const saved:unknown[]=[];let enabled=true;
 const post=createMobileScanPost({authenticate:async token=>{assert.equal(token,"paired");return{id:"device-owned"};},allowed:async()=>enabled,save:async(device,report)=>{saved.push({device,report});},authStatus:()=>null});
 const req=(b:unknown,auth=true)=>new Request("https://manager/api/collector/facebook/mobile/scan",{method:"POST",headers:auth?{authorization:"Bearer paired"}:{},body:JSON.stringify(b)});
 assert.equal((await post(req(body(),false))).status,401);assert.equal(saved.length,0);
 enabled=false;assert.equal((await post(req(body()))).status,409);assert.equal(saved.length,0);
 enabled=true;const r=await post(req(body()));assert.equal(r.status,200);assert.deepEqual(await r.json(),{batchId:body().batchId});assert.equal((saved[0] as {device:string}).device,"device-owned");
 assert.equal((await post(req({...body(),text:"x".repeat(65536)}))).status,413);
});
test("returns retry on storage or authentication errors without echoing private details",async()=>{
 const post=createMobileScanPost({authenticate:async()=>({id:"d"}),allowed:async()=>true,save:async()=>{throw Error("private database details");},authStatus:()=>null});
 const response=await post(new Request("https://manager/scan",{method:"POST",headers:{authorization:"Bearer paired"},body:JSON.stringify(body())}));assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:"SCAN_REPORT_RETRY"});
});

test("typed profile report permits opaque IDs only with matching source key",async()=>{
 const report={...body(),version:2,sourceType:"PROFILE",sourceId:"61563667387467",groupId:"profile:61563667387467",posts:[{...body().posts[0],postId:"pfbidAbCdEf0123456789"}]};
 assert.ok(parseMobileScan(report));
 for(const bad of [{...report,groupId:"61563667387467"},{...report,sourceId:"100008036582269"},{...report,sourceType:"GROUP"},{...report,text:"private"},{...body(),posts:report.posts}])assert.equal(parseMobileScan(bad),null);
 let permitted:unknown;
 const post=createMobileScanPost({authenticate:async()=>({id:"owned"}),allowed:async(id,type)=>{permitted=[id,type];return true;},save:async()=>{},authStatus:()=>null});
 assert.equal((await post(new Request("https://manager/scan",{method:"POST",headers:{authorization:"Bearer paired"},body:JSON.stringify(report)}))).status,200);assert.deepEqual(permitted,[report.sourceId,"PROFILE"]);
});
