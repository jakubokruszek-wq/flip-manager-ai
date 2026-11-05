import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { createMobileDiscoveryPost } from "@/features/collector/facebook-mobile-discovery";
import { discoverFacebookGroups } from "@/features/facebook-groups/server";
export const runtime = "nodejs";
export const POST = createMobileDiscoveryPost({
  authenticate: authenticateCollectorDevice,
  discover: discoverFacebookGroups,
  authStatus: error => error instanceof CollectorAuthError ? error.status : null,
});
