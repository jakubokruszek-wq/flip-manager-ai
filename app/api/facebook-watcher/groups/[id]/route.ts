import { createFacebookGroupsApi } from "@/features/facebook-groups/api-handlers";
import { requireFacebookGroupsUser } from "@/features/facebook-groups/api-auth";
import { removeWatchedFacebookGroup, updateWatchedFacebookGroupDetails } from "@/features/facebook-groups/server";

type Context = { params: Promise<{ id: string }> };

const api = createFacebookGroupsApi({
  requireUser: requireFacebookGroupsUser,
  list: async () => [],
  add: async () => ({ success: false, duplicate: false, validationError: true, error: "METHOD_NOT_ALLOWED" }),
  update: updateWatchedFacebookGroupDetails,
  remove: removeWatchedFacebookGroup,
});

export async function PATCH(request: Request, { params }: Context) {
  return api.patch((await params).id, request);
}

export async function DELETE(_request: Request, { params }: Context) {
  return api.delete((await params).id);
}
