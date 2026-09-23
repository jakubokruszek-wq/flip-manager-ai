import { createFacebookGroupHistoricalMappingApi } from "@/features/facebook-groups/api-handlers";
import { getHistoricalFacebookSourceMapping } from "@/features/facebook-groups/server";

const api = createFacebookGroupHistoricalMappingApi({ mapping: getHistoricalFacebookSourceMapping });

export const GET = api.get;
