/** Actual Watcher -> Finder orchestration over PostgREST and native PostgreSQL.
 * Only the admin-client factory is substituted. No persistence/normalization RPC is mocked. */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAndroidDataOnlyImport } from "./import-policy.ts";
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
test("actual importer normalizes 260 tyś and persists Finder membership, metadata and history", async()=>{
  const result=await runAndroidDataOnlyImport(()=>importFacebookWatcher(input,context));
  assert.equal(result.listingCreated,true); assert.ok(result.listingId);
  const row=await db.from("listings").select("price,area,source").eq("id",result.listingId).single();
  assert.equal(row.error,null); assert.equal(row.data?.price,260000); assert.equal(row.data?.area,50);assert.equal(row.data?.source,"facebook");
  for(const table of ["listing_source_metadata","listing_snapshots","listing_filter_matches"]) {
    const stored=await db.from(table).select("*").eq("listing_id",result.listingId);
    assert.equal(stored.error,null,table+": "+stored.error?.message);assert.equal(stored.data?.length,1,table);
  }
  const again=await runAndroidDataOnlyImport(()=>importFacebookWatcher(input,context));
  assert.equal(again.listingId,result.listingId);assert.equal(again.listingCreated,false);assert.equal(again.listingUpdated,false);
  const history=await db.from("listing_snapshots").select("id").eq("listing_id",result.listingId);
  assert.equal(history.data?.length,1);
});
test("sale gate rejects rent and buy without creating Finder records",async()=>{
  for(const text of ["Wynajmę mieszkanie 50 m2 Łódź 2000 zł miesięcznie","Kupię mieszkanie w Łodzi do 300000 zł"]) {
    const result=await runAndroidDataOnlyImport(()=>importFacebookWatcher({...input,postText:text},context));
    assert.equal(result.status,"skipped");assert.equal(result.listingId,null);
  }
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
