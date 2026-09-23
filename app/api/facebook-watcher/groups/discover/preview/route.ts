import { createFacebookGroupDiscoveryPreviewApi } from "@/features/facebook-groups/api-handlers";
import { previewDiscoveryToken } from "@/features/facebook-groups/server";

const api = createFacebookGroupDiscoveryPreviewApi({ preview: previewDiscoveryToken });

export const POST = api.post;
