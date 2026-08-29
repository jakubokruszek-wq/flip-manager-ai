import { createFacebookGroupsApi } from "@/features/facebook-groups/api-handlers";
import { addWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupsApi({
  list: listWatchedFacebookGroups,
  add: addWatchedFacebookGroup,
  update: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
  remove: async () => { throw new Error("METHOD_NOT_ALLOWED"); },
});

export const GET = api.get;
export const POST = api.post;
