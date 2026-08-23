import { createFacebookGroupsApi } from "@/features/facebook-groups/api-handlers";
import { requireFacebookGroupsUser } from "@/features/facebook-groups/api-auth";
import { addWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupsApi({
  requireUser: requireFacebookGroupsUser,
  list: listWatchedFacebookGroups,
  add: addWatchedFacebookGroup,
  update: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
  remove: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
});

export const GET = api.get;
export const POST = api.post;
