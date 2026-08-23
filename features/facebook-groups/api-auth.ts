import "server-only";

import { createClient } from "@/lib/supabase/server";
import { assertAuthenticatedFacebookGroupUser } from "./management";

export async function requireFacebookGroupsUser(request?: Request): Promise<void> {
  const supabase = await createClient();
  const token = request?.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const { data: { user }, error } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser();
  if (error) throw new Error("UNAUTHORIZED");
  assertAuthenticatedFacebookGroupUser(user);
}
