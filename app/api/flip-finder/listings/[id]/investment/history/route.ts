import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { dealRoomEnabled, DealRoomNotFound, readDealRoomHistory } from "@/features/investment-os/server/deal-room-service";
import { testListingAllowed } from "@/features/investment-os/test-mode";
export async function GET(request: Request,{params}:{params:Promise<{id:string}>}) {
 let actor;try{actor=await requireOperator();}catch(error){return operatorAuthorizationResponse(error);}
 const {id}=await params;
 if(!dealRoomEnabled()||!testListingAllowed(id,actor.id))return Response.json({code:"NOT_FOUND"},{status:404});
 const before=new URL(request.url).searchParams.get("before");
 if(before && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(before))return Response.json({code:"INVALID_CURSOR"},{status:400});
 try{return Response.json(await readDealRoomHistory(id,actor.id,before),{headers:{"Cache-Control":"private, no-store"}});}
 catch(error){return Response.json({code:error instanceof DealRoomNotFound?"NOT_FOUND":"HISTORY_UNAVAILABLE"},{status:error instanceof DealRoomNotFound?404:503});}
}
