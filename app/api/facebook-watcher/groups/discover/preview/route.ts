import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createFacebookGroupDiscoveryPreviewApi } from "@/features/facebook-groups/api-handlers";
import { previewDiscoveryToken } from "@/features/facebook-groups/server";

const api = createFacebookGroupDiscoveryPreviewApi({ preview: previewDiscoveryToken });

export async function POST(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  return api.post(request);
}
