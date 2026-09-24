import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

const AUTH_COOKIE_DEFAULTS: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function requiredAuthEnvironment() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Brak konfiguracji Supabase Auth po stronie serwera.");
  return { url, publishableKey };
}

export function hardenedAuthCookieOptions(options: CookieOptions = {}): CookieOptions {
  return { ...options, ...AUTH_COOKIE_DEFAULTS };
}

export async function createAuthServerClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = requiredAuthEnvironment();
  return createServerClient(url, publishableKey, {
    cookieOptions: AUTH_COOKIE_DEFAULTS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, hardenedAuthCookieOptions(options));
          }
        } catch {
          // Server Components cannot write cookies. The root proxy refreshes
          // the session before rendering and persists any refreshed tokens.
        }
      },
    },
  });
}
