import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createFacebookGroupHistoricalMappingApi } from "@/features/facebook-groups/api-handlers";
import { getHistoricalFacebookSourceMapping } from "@/features/facebook-groups/server";

const api = createFacebookGroupHistoricalMappingApi({ mapping: getHistoricalFacebookSourceMapping });

export async function GET() {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return api.get();
}
