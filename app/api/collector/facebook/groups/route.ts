import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { createCollectorGroupsGet } from "@/features/collector/facebook-groups-feed";
import { listWatchedFacebookGroups } from "@/features/facebook-groups/server";

export const GET = createCollectorGroupsGet({
  authenticate: authenticateCollectorDevice,
  list: listWatchedFacebookGroups,
  authStatus: error => error instanceof CollectorAuthError ? error.status : 503,
});
