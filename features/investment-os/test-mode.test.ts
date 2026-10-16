import test from "node:test";
import assert from "node:assert/strict";
import { testCases, testModeAllowed, testListingAllowed } from "./test-mode";
const owner="33333333-3333-4333-8333-333333333333", other="55555555-5555-4555-8555-555555555555";
const env={DEAL_ROOM_TEST_ENABLED:"true",DEAL_ROOM_QA_ENABLED:"true",DEAL_ROOM_TEST_DATABASE_ORIGIN:"http://127.0.0.1:55439",NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:55439",DEAL_ROOM_TEST_OPERATOR_IDS:owner};
test("test mode fails closed on disabled flag, wrong account, production, credentials, insecure or mismatched DB",()=>{
 assert.equal(testModeAllowed(owner,env),true);
 for(const patch of [{DEAL_ROOM_TEST_ENABLED:"false"},{DEAL_ROOM_QA_ENABLED:"false"},{VERCEL_ENV:"production"},{DEAL_ROOM_TEST_OPERATOR_IDS:other},{DEAL_ROOM_TEST_DATABASE_ORIGIN:"https://different.test"},{NEXT_PUBLIC_SUPABASE_URL:"https://zmuisdirvfcxrvtbvrle.supabase.co",DEAL_ROOM_TEST_DATABASE_ORIGIN:"https://zmuisdirvfcxrvtbvrle.supabase.co"},{NEXT_PUBLIC_SUPABASE_URL:"http://unsafe.test",DEAL_ROOM_TEST_DATABASE_ORIGIN:"http://unsafe.test"},{NEXT_PUBLIC_SUPABASE_URL:"http://user:pass@127.0.0.1:55439"}])assert.equal(testModeAllowed(owner,{...env,...patch}),false);
 assert.equal(testModeAllowed("not-a-uuid",env),false);
});
test("synthetic identities are stable and scoped to actor; ordinary IDs unaffected by rollback",()=>{
 const cases=testCases(owner);assert.equal(cases.length,3);assert.deepEqual(cases,testCases(owner));assert.equal(new Set([...cases,...testCases(other)].map(c=>c.id)).size,6);
 assert.equal(testListingAllowed("22222222-2222-4222-8222-222222222222",owner),true);
 assert.equal(testListingAllowed(cases[0].id,owner),false);
 const old={...process.env};try{Object.assign(process.env,env);assert.equal(testListingAllowed(cases[0].id,owner),true);assert.equal(testListingAllowed(cases[0].id,other),false);process.env.DEAL_ROOM_TEST_ENABLED="false";assert.equal(testListingAllowed(cases[0].id,owner),false);}finally{for(const k of Object.keys(env))if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});
