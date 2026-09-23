import { authenticateSignedCollectorRequest } from "@/features/collector/signed-device-auth";
import { createFacebookGroupDiscoveryApi } from "@/features/facebook-groups/api-handlers";
import { getLastFacebookGroupDiscoveryPreview, previewDiscoveredFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupDiscoveryApi({
  preview: previewDiscoveredFacebookGroups,
  lastPreview: getLastFacebookGroupDiscoveryPreview,
  authenticate: async (request, body) => { await authenticateSignedCollectorRequest({ request, pathname: "/api/facebook-watcher/groups/discover", body }); },
});

export const POST = api.post;
export const GET = api.get;
