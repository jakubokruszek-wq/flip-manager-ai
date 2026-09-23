import { authenticateSignedCollectorRequest } from "@/features/collector/signed-device-auth";
import { createFacebookGroupDiscoveryApi } from "@/features/facebook-groups/api-handlers";
import { discoverFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupDiscoveryApi({
  discover: discoverFacebookGroups,
  authenticate: async (request, body) => {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: "/api/facebook-watcher/groups/discover", body });
    return { deviceId: device.id };
  },
});

export const POST = api.post;
