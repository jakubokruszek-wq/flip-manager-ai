import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createFacebookGroupsApi } from "@/features/facebook-groups/api-handlers";
import { addWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupsApi({
  list: listWatchedFacebookGroups,
  add: addWatchedFacebookGroup,
  update: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
  remove: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
});

export async function GET() {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return api.get();
}

export async function POST(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return api.post(request);
}
