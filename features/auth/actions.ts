"use server";

import { redirect } from "next/navigation";

import { requireOperator } from "@/features/auth/operator";
import { createAuthServerClient } from "@/lib/supabase/auth-server";

export async function logoutOperator(): Promise<never> {
  await requireOperator();
  const supabase = await createAuthServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
