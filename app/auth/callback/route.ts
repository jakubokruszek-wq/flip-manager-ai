import { NextResponse, type NextRequest } from "next/server";

import { safeReturnTo } from "@/features/auth/return-to";
import { createAuthServerClient } from "@/lib/supabase/auth-server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/login", request.url));
  const supabase = await createAuthServerClient();
  const exchanged = await supabase.auth.exchangeCodeForSession(code);
  const verified = exchanged.error ? null : await supabase.auth.getUser();
  if (exchanged.error || verified?.error || verified?.data.user?.app_metadata?.role !== "operator") {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.redirect(new URL(safeReturnTo(request.nextUrl.searchParams.get("returnTo")), request.url));
}
