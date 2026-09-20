import { timingSafeEqual } from "node:crypto";

export type OperatorAuthResult = { authorized: true } | { authorized: false; status: 401 | 403 };

/**
 * Reuses this codebase's established administrative-authorization model
 * instead of inventing a second one. This app has no multi-user session
 * system at all — no Supabase Auth, no NextAuth, no middleware.ts, no
 * `role`/`is_admin` concept anywhere (confirmed by direct inspection); it is
 * a single-owner deployment. Every other privileged, non-worker mutation
 * already established for this exact situation uses a server-side shared
 * secret presented as a Bearer token — see
 * app/api/flip-finder/search-filters/[id]/recalculate/route.ts and
 * app/api/jobs/listing-lifecycle/route.ts. This reuses that same pattern
 * (with the same timing-safe comparison as the recalculate route) as the
 * real ownership/operator boundary for orphan detection and repair.
 *
 * - No Authorization header at all, or not a Bearer token -> 401: no
 *   authentication was attempted, so there is nothing to authorize.
 * - A Bearer token that does not match the configured secret (or the secret
 *   is not configured at all) -> 403: an identity was presented but it does
 *   not carry this privilege.
 * - The exact configured secret -> authorized.
 *
 * Origin / Sec-Fetch-Site / the x-facebook-watcher-action header may remain
 * as defense-in-depth elsewhere, but this function is the sole authorization
 * boundary: none of those client-supplied headers can substitute for it.
 */
export function authorizeFacebookOrphanOperator(request: Request): OperatorAuthResult {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return { authorized: false, status: 401 };
  const configuredSecret = process.env.FACEBOOK_ORPHAN_REPAIR_SECRET;
  if (!configuredSecret || !timingSafeEqualStrings(configuredSecret, match[1])) return { authorized: false, status: 403 };
  return { authorized: true };
}

function timingSafeEqualStrings(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}
