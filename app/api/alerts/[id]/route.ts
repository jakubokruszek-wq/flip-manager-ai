import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { markAlertRead } from "@/features/alerts/server";
type Context={params:Promise<{id:string}>};
export async function PATCH(_request:Request,{params}:Context){
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }try{await markAlertRead((await params).id);return Response.json({ok:true});}catch(error){return Response.json({error:error instanceof Error?error.message:"Nie udało się oznaczyć alertu."},{status:500});}}
