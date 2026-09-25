import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { safeReturnTo } from "@/features/auth/return-to";
import { hardenedAuthCookieOptions } from "@/lib/supabase/auth-server";

const PUBLIC_PATHS = new Set(["/login", "/auth/callback", "/api/build-info"]);
const MACHINE_API_PREFIXES = ["/api/collector/", "/api/facebook-worker/", "/api/olx-worker/", "/api/jobs/"];

function isMachinePath(pathname: string): boolean {
  return MACHINE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || pathname === "/api/facebook-watcher/orphans" || pathname === "/api/facebook-watcher/groups/discover";
}

export async function refreshOperatorSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const pathname = request.nextUrl.pathname;

  if (!url || !publishableKey) {
    if (PUBLIC_PATHS.has(pathname) || isMachinePath(pathname)) return response;
    return NextResponse.json({ ok: false, code: "AUTH_CONFIGURATION_MISSING" }, { status: 503 });
  }

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, hardenedAuthCookieOptions(options));
        response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  const operator = !error && data.user?.app_metadata?.role === "operator";
  if (PUBLIC_PATHS.has(pathname) || isMachinePath(pathname)) {
    if (pathname === "/login" && operator) {
      return NextResponse.redirect(new URL(safeReturnTo(request.nextUrl.searchParams.get("returnTo")), request.url));
    }
    return response;
  }

  if (!operator) {
    if (pathname.startsWith("/api/")) {
      const missing = Boolean(error || !data.user);
      return NextResponse.json({ ok: false, code: missing ? "OPERATOR_SESSION_REQUIRED" : "OPERATOR_ROLE_REQUIRED" }, { status: missing ? 401 : 403 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  return response;
}
