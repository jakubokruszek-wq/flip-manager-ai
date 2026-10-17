import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { testCases, testModeAllowed } from "./test-mode";
import { buildTestDeal } from "./test-engine";
import { TEST_DEAL_FEATURES } from "./test-features";
import { buildDealBrain } from "../../brain";
import { affectedDirectors, answerOverrides, mergeAnswers, parseAnswerCommand, type DealRoomState } from "../../deal-room-answers";
import type { CanonicalDeal } from "../../types";
import { InvestmentDealVersionConflict } from "../../server/deal-cas";
type TestRow={case_id:string;version:number;deal:CanonicalDeal;state:Omit<DealRoomState,"version">};
export class TestUnavailable extends Error {}
export class TestNotFound extends Error {}
export async function testDatabase(actorId:string) {
 if(!testModeAllowed(actorId))throw new TestNotFound();
 const db=createAdminClient();
 const {data,error}=await db.rpc("deal_room_test_contract");
 if(error||data!==1)throw new TestUnavailable();
 return db;
}
function ownCase(actorId:string,id:string){if(!testModeAllowed(actorId)||!testCases(actorId).some(c=>c.id===id))throw new TestNotFound();}
/** Writes ONLY dedicated TEST tables. No real listing/Radar/service resolver is imported. */
export async function prepareTestCases(actorId:string){
 const db=await testDatabase(actorId),cases=testCases(actorId);
 const rows=cases.map(c=>({owner_id:actorId,case_id:c.id,deal:buildTestDeal(actorId,c.id),state:{answers:{},baselineOverrides:{},rounds:[]}}));
 const {error}=await db.from("deal_room_test_cases").upsert(rows,{onConflict:"owner_id,case_id",ignoreDuplicates:true});
 if(error)throw new TestUnavailable();return cases;
}
export async function readTestCase(actorId:string,id:string):Promise<TestRow|null>{
 ownCase(actorId,id);const db=await testDatabase(actorId);
 const {data,error}=await db.from("deal_room_test_cases").select("case_id,version,deal,state").eq("owner_id",actorId).eq("case_id",id).maybeSingle();
 if(error)throw new TestUnavailable();return data as TestRow|null;
}
export async function saveTestAnswers(actorId:string,id:string,raw:unknown){
 ownCase(actorId,id);const command=parseAnswerCommand(raw,TEST_DEAL_FEATURES),db=await testDatabase(actorId);
 const hash=createHash("sha256").update(JSON.stringify(command)).digest("hex");
 const {data:replay,error:replayError}=await db.from("deal_room_test_rounds").select("payload_hash,response").eq("owner_id",actorId).eq("case_id",id).eq("request_id",command.requestId).maybeSingle();
 if(replayError)throw new TestUnavailable();
 if(replay){if(replay.payload_hash!==hash)throw new InvestmentDealVersionConflict();return replay.response;}
 const stored=await readTestCase(actorId,id);if(!stored)throw new TestNotFound();
 if(stored.version!==command.expectedVersion)throw new InvestmentDealVersionConflict();
 const now=new Date().toISOString(),state={...stored.state,version:stored.version};
 const answers=mergeAnswers(stored.deal,state,command,actorId,now,TEST_DEAL_FEATURES);
 const deal=buildTestDeal(actorId,id,answerOverrides(stored.deal,state.baselineOverrides,answers));
 const invalidated=affectedDirectors(command.answers.map(a=>a.field));
 const round={requestId:command.requestId,savedAt:now,actorId,changedFields:command.answers.map(a=>a.field),invalidated,before:buildDealBrain(stored.deal),after:buildDealBrain(deal)};
 const next={...stored.state,answers,rounds:[round]};
 const response={ok:true,deal,room:{...next,version:stored.version+1},invalidated};
 const {data,error}=await db.rpc("deal_room_test_commit",{p_owner_id:actorId,p_case_id:id,p_expected_version:stored.version,p_request_id:command.requestId,p_payload_hash:hash,p_deal:deal,p_state:next,p_response:response});
 if(error){if(error.message.includes("INVESTMENT_DEAL_VERSION_CONFLICT"))throw new InvestmentDealVersionConflict();throw new TestUnavailable();}
 return data;
}
export async function readTestHistory(actorId:string,id:string,before:string|null){
 ownCase(actorId,id);const db=await testDatabase(actorId);
 let q=db.from("deal_room_test_rounds").select("request_id,created_at,response").eq("owner_id",actorId).eq("case_id",id).order("created_at",{ascending:false}).order("request_id",{ascending:false}).limit(21);
 if(before){const [at,request]=before.split("|");q=q.or(`created_at.lt.${at},and(created_at.eq.${at},request_id.lt.${request})`);}
 const {data,error}=await q;if(error)throw new TestUnavailable();const rows=data??[],page=rows.slice(0,20);
 return {rounds:page.map(row=>{const round=(row.response as {room:DealRoomState}).room.rounds[0];return {requestId:row.request_id,createdAt:row.created_at,changedFields:round?.changedFields??[],beforeProfit:round?.before.financials?.profitBase??null,afterProfit:round?.after.financials?.profitBase??null,recommendation:round?.after.ceo.reasoningSummary??"TEST"};}),nextBefore:rows.length>20?`${page.at(-1)!.created_at}|${page.at(-1)!.request_id}`:null};
}
