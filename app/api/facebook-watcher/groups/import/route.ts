import { createFacebookGroupImportApi } from "@/features/facebook-groups/api-handlers";
import { importSelectedFacebookGroups } from "@/features/facebook-groups/server";

const api = createFacebookGroupImportApi({ importSelected: importSelectedFacebookGroups });

export const POST = api.post;
