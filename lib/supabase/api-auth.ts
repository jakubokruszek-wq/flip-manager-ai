import "server-only";

import { createClient } from "@/lib/supabase/server";
import { authenticateApiUserWithClient, type ApiAuthUser } from "@/lib/supabase/api-auth-core";

export async function authenticateApiUser(request: Request): Promise<ApiAuthUser | null> {
  return authenticateApiUserWithClient(request, await createClient());
}

export async function requireAuthenticatedApiUser(request: Request): Promise<ApiAuthUser> {
  const user = await authenticateApiUser(request);
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}
