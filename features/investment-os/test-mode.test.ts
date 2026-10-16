import test from "node:test";
import assert from "node:assert/strict";
import { testCases, testModeAllowed, testListingAllowed } from "./test-mode";
import { investmentPath } from "./test-identity";
const owner="33333333-3333-4333-8333-333333333333",other="55555555-5555-4555-8555-555555555555";
const env={DEAL_ROOM_TEST_ENABLED:"true",DEAL_ROOM_TEST_STORAGE_VERSION:"1",DEAL_ROOM_TEST_OPERATOR_IDS:owner};
test("TEST requires new explicit storage contract, valid allowlisted UID and switch; existing project alone never authorizes it",()=>{
 assert.equal(testModeAllowed(owner,env),true);
 for(const patch of [{DEAL_ROOM_TEST_ENABLED:"false"},{DEAL_ROOM_TEST_STORAGE_VERSION:""},{DEAL_ROOM_TEST_STORAGE_VERSION:"2"},{DEAL_ROOM_TEST_OPERATOR_IDS:""},{DEAL_ROOM_TEST_OPERATOR_IDS:other},{DEAL_ROOM_TEST_OPERATOR_IDS:"not-a-uuid"}])assert.equal(testModeAllowed(owner,{...env,...patch}),false);
 assert.equal(testModeAllowed("not-a-uuid",env),false);
 assert.equal(testModeAllowed(owner,{...env,VERCEL_ENV:"production",NEXT_PUBLIC_SUPABASE_URL:"https://zmuisdirvfcxrvtbvrle.supabase.co"}),true,"same project only with approved new store; database runtime contract checked separately");
 assert.equal(testModeAllowed(owner,{DEAL_ROOM_TEST_ENABLED:"true",DEAL_ROOM_TEST_DATABASE_ORIGIN:"https://zmuisdirvfcxrvtbvrle.supabase.co",DEAL_ROOM_TEST_OPERATOR_IDS:owner}),false,"old flags cannot activate rewritten path");
});
test("virtual identities stable and owner scoped; normal investment endpoints reject every TEST ID unconditionally",()=>{
 const a=testCases(owner),b=testCases(other);assert.deepEqual(a,testCases(owner));assert.equal(new Set([...a,...b].map(c=>c.id)).size,6);
 for(const c of a){assert.equal(testListingAllowed(c.id,owner),false);assert.match(investmentPath(c.id),/^\/api\/deal-room\/test\/deadbeef-/);}
 assert.equal(testListingAllowed("22222222-2222-4222-8222-222222222222",owner),true);
});
