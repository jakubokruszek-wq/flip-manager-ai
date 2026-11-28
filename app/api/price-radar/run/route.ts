import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

const headers = { "Cache-Control": "private, no-store" };
async function retired(status: number) {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }
  return Response.json({ run: null, status: "retired", code: "RCN_RADAR_REPLACED_ASKING_COLLECTOR", message: "Radar korzysta teraz z transakcji RCN. Zbieranie cen ofertowych zostało wyłączone." }, { status, headers });
}
export async function GET() { return retired(200); }
export async function POST() { return retired(410); }
