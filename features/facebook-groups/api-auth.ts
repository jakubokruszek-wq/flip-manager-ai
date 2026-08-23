import "server-only";

import { createClient } from "@/lib/supabase/server";
import { assertAuthenticatedFacebookGroupUser } from "./management";

export async function requireFacebookGroupsUser(): Promise<void> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw new Error("UNAUTHORIZED");
  assertAuthenticatedFacebookGroupUser(user);
}
