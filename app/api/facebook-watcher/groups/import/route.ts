import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createFacebookGroupImportApi } from "@/features/facebook-groups/api-handlers";
import { importSelectedFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupImportApi({ importSelected: importSelectedFacebookGroups });

export async function POST(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return api.post(request);
}
