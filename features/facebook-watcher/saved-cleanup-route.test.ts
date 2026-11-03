import assert from "node:assert/strict";
import test,{mock} from "node:test";
let authorized=true,calls=0,dbError:string|null=null;
const captured:Array<Record<string,unknown>>=[];
mock.module("@/features/auth/operator",{namedExports:{requireOperator:async()=>{if(!authorized)throw new Error("login");},operatorAuthorizationResponse:()=>Response.json({code:"AUTH_REQUIRED"},{status:401})}});
mock.module("@/features/facebook-watcher/supabase-admin",{namedExports:{createFacebookWatcherAdminClient:()=>({rpc:async(_name:string,args:Record<string,unknown>)=>{calls++;captured.push(args);return {data:{token:"a".repeat(32),total:1,protectedCount:0,listingIds:["old"],applied:args.p_apply},error:dbError?{message:dbError}:null};}})}});
const {GET,DELETE}=await import("../../app/api/facebook-watcher/history/by-saved-date/route.ts");
const before="2026-11-01T23:00:00.000Z";
function request(body:unknown={before,token:"a".repeat(32)},origin="https://flip-manager-ai.vercel.app"){
 return new Request("https://flip-manager-ai.vercel.app/api/facebook-watcher/history/by-saved-date",{method:"DELETE",headers:{origin,"sec-fetch-site":"same-origin","x-facebook-watcher-action":"clear-watcher-history","content-type":"application/json"},body:JSON.stringify(body)});
}
test("preview requires login and explicit cutoff, and never applies deletion",async()=>{
 authorized=false;calls=0;assert.equal((await GET(new Request("https://manager.test?before="+before))).status,401);assert.equal(calls,0);
 authorized=true;assert.equal((await GET(new Request("https://manager.test"))).status,400);assert.equal(calls,0);
 const response=await GET(new Request("https://manager.test?before="+encodeURIComponent(before)));assert.equal(response.status,200);
 assert.equal(captured.at(-1)?.p_apply,false);assert.equal(response.headers.get("cache-control"),"private, no-store");
});
test("apply rejects forged origin and absent preview token before RPC",async()=>{
 calls=0;assert.equal((await DELETE(request(undefined,"https://attacker.test"))).status,403);
 assert.equal((await DELETE(request({before}))).status,400);assert.equal(calls,0);
 const response=await DELETE(request());assert.equal(response.status,200);assert.equal(captured.at(-1)?.p_apply,true);assert.equal(captured.at(-1)?.p_expected,"a".repeat(32));
});
test("changed previews and active jobs require a new preview, database details do not leak",async()=>{
 for(const code of ["CLEANUP_PREVIEW_CHANGED","ACTIVE_FACEBOOK_WORK"]){dbError=code;assert.equal((await DELETE(request())).status,409);}
 dbError="password=never-expose";const response=await DELETE(request());assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes("never-expose"));dbError=null;
});
