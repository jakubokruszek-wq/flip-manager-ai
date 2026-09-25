import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createFacebookGroupsApi } from "@/features/facebook-groups/api-handlers";
import { removeWatchedFacebookGroup, updateWatchedFacebookGroupDetails } from "@/features/facebook-groups/server";

type Context = { params: Promise<{ id: string }> };

const api = createFacebookGroupsApi({
  list: async () => [],
  add: async () => ({ success: false, duplicate: false, validationError: true, error: "METHOD_NOT_ALLOWED" }),
  update: updateWatchedFacebookGroupDetails,
  remove: removeWatchedFacebookGroup,
});

export async function PATCH(request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  return api.patch((await params).id, request);
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  void request;
  return api.delete((await params).id);
}
