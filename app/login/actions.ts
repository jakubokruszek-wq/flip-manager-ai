"use server";

import { redirect } from "next/navigation";

import { safeReturnTo } from "@/features/auth/return-to";
import { createAuthServerClient } from "@/lib/supabase/auth-server";

export type LoginState = Readonly<{ error: string | null }>;

export async function loginOperator(_state: LoginState, formData: FormData): Promise<LoginState> {
  const emailValue = formData.get("email");
  const passwordValue = formData.get("password");
  const destination = safeReturnTo(formData.get("returnTo"));
  const email = typeof emailValue === "string" ? emailValue.trim().slice(0, 320) : "";
  const password = typeof passwordValue === "string" ? passwordValue.slice(0, 1_024) : "";
  if (!email || !password) return { error: "Podaj adres e-mail i hasło." };

  const supabase = await createAuthServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Nieprawidłowy e-mail lub hasło." };
  const verified = await supabase.auth.getUser();
  if (verified.error || verified.data.user?.app_metadata?.role !== "operator") {
    await supabase.auth.signOut();
    return { error: "To konto nie ma dostępu operatora." };
  }
  redirect(destination);
}
