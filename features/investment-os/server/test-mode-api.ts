import "server-only";
import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { testCases, testModeAllowed } from "../test-mode";
import { DealRoomInputError } from "../deal-room-answers";
import { isInvestmentDealVersionConflict } from "./deal-cas";
import { prepareTestCases, readTestCase, readTestHistory, saveTestAnswers, testDatabase, TestNotFound } from "./test-mode-service";
const headers={"Cache-Control":"private, no-store"};
export async function testModeApi(request:Request,action:"catalog"|"deal"|"initialize"|"answers"|"history",id?:string):Promise<Response>{
 let actor;try{actor=await requireOperator();}catch(error){return operatorAuthorizationResponse(error);}
 if(!testModeAllowed(actor.id)||(id&&!testCases(actor.id).some(c=>c.id===id)))return Response.json({code:"NOT_FOUND"},{status:404,headers});
 if(request.method!=="GET" && request.headers.get("origin")!==new URL(request.url).origin)return Response.json({code:"ORIGIN_MISMATCH"},{status:403,headers});
 try{
  if(action==="catalog"){
   if(request.method==="POST")return Response.json({cases:await prepareTestCases(actor.id)},{headers});
   await testDatabase(actor.id);return Response.json({cases:testCases(actor.id)},{headers});
  }
  if(!id)throw new TestNotFound();
  if(action==="history"){
   const before=new URL(request.url).searchParams.get("before");
   if(before&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(before))return Response.json({code:"INVALID_CURSOR"},{status:400,headers});
   return Response.json(await readTestHistory(actor.id,id,before),{headers});
  }
  if(action==="answers"&&request.method==="POST"){
   if(!request.headers.get("content-type")?.startsWith("application/json"))return Response.json({code:"JSON_REQUIRED"},{status:415,headers});
   const raw=await request.text();if(new TextEncoder().encode(raw).length>24000)return Response.json({code:"PAYLOAD_TOO_LARGE"},{status:413,headers});
   let body:unknown;try{body=JSON.parse(raw);}catch{throw new DealRoomInputError("Nieprawidłowy JSON.");}
   return Response.json(await saveTestAnswers(actor.id,id,body),{headers});
  }
  const row=await readTestCase(actor.id,id);
  if(!row)return Response.json({code:"NOT_COMPUTED"},{status:404,headers});
  if(request.method==="PUT")return Response.json({code:"USE_DEAL_ROOM_ANSWERS"},{status:409,headers});
  return Response.json(action==="answers"?{enabled:true,room:{...row.state,version:row.version}}:{ok:true,deal:row.deal,media:[]},{headers});
 }catch(error){
  if(error instanceof DealRoomInputError)return Response.json({code:"INVALID_ANSWER",message:error.message},{status:400,headers});
  if(isInvestmentDealVersionConflict(error))return Response.json({code:"INVESTMENT_DEAL_VERSION_CONFLICT",message:"Analiza zmieniła się. Odśwież przed zapisem."},{status:409,headers});
  return Response.json({code:error instanceof TestNotFound?"NOT_FOUND":"TEST_STORAGE_UNAVAILABLE"},{status:error instanceof TestNotFound?404:503,headers});
 }
}
