import "server-only";

import { requireAuthenticatedApiUser } from "@/lib/supabase/api-auth";
import { assertAuthenticatedFacebookGroupUser } from "./management";

export async function requireFacebookGroupsUser(request?: Request): Promise<void> {
  if (!request) throw new Error("UNAUTHORIZED");
  const user = await requireAuthenticatedApiUser(request);
  assertAuthenticatedFacebookGroupUser(user);
}
