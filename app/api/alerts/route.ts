import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { getAlerts } from "@/features/alerts/server";
export async function GET(){
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }try{const alerts=await getAlerts();return Response.json({alerts,unreadCount:alerts.filter(alert=>!alert.readAt).length});}catch(error){return Response.json({error:error instanceof Error?error.message:"Nie udało się pobrać alertów."},{status:500});}}
