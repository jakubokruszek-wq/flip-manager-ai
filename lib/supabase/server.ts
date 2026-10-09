import "server-only";

import { createAuthServerClient } from "@/lib/supabase/auth-server";

/**
 * Was building a plain supabase-js client with no cookie/session forwarding
 * at all -- every query through it ran as `anon`, auth.uid() always null.
 * That was invisible while every RLS policy on the tables this reaches
 * (listings, search_filters, source_scans, resale_comps, ...) was an
 * unconditional `true`. It stopped being invisible the moment the identity
 * migrations added finder_listing_identity_groups/decisions with a real,
 * correctly owner-scoped RLS policy and anon explicitly revoked: every
 * authenticated operator's own read of their own data started failing with
 * a genuine 42501 permission-denied, surfacing to the Finder results route
 * as "Nie udało się pobrać wyników filtra". createAuthServerClient (used
 * correctly elsewhere, e.g. features/auth/operator.ts's session check) is
 * the real, cookie-forwarding client; this just delegates to it so every
 * caller of createClient() gets a client that is actually the signed-in
 * operator, not anon.
 */
export async function createClient() {
  return createAuthServerClient();
}
