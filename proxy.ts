import type { NextRequest } from "next/server";

import { refreshOperatorSession } from "@/lib/supabase/auth-proxy";

export async function proxy(request: NextRequest) {
  return refreshOperatorSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|apple-icon|icon|manifest.webmanifest|sw.js|workbox-|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)"],
};
