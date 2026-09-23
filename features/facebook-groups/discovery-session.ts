import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import type { DiscoveredFacebookGroupCandidate } from "./discovery";

export const DISCOVERY_SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_DISCOVERY_CANDIDATES = 200;

export type DiscoverySession = {
  id: string;
  candidates: DiscoveredFacebookGroupCandidate[];
  expiresAt: string;
  consumedAt: string | null;
};

/**
 * Replaces the module/global "last discovery preview" store, which does not
 * survive a Vercel cold start and has no shared state across concurrent
 * serverless instances -- a real defect, not a style preference, confirmed
 * by an independent review. This table (facebook_group_discovery_sessions)
 * is the only storage; every instance reads the same row.
 *
 * The returned token is `<sessionId>.<secret>`: `<sessionId>` is this row's
 * own primary key, giving an O(1) lookup by any instance; `<secret>` is
 * never stored -- only its SHA-256 hash is -- and is compared in constant
 * time on lookup (see resolveDiscoverySessionToken) so that even a party
 * with direct row access (which requires the service_role key, never
 * exposed to any client) gains no timing signal.
 */
export async function createDiscoverySession(candidates: DiscoveredFacebookGroupCandidate[], deviceId: string | null): Promise<{ token: string; expiresAt: string }> {
  if (candidates.length > MAX_DISCOVERY_CANDIDATES) throw new Error("DISCOVERY_TOO_MANY_CANDIDATES");
  const admin = createFacebookWatcherAdminClient();
  const now = Date.now();
  // Opportunistic cleanup on every write, mirroring the existing
  // collector_request_nonces/olx_worker_nonces pattern elsewhere in this
  // codebase -- a short-TTL table like this one never needs a separate cron.
  await admin.from("facebook_group_discovery_sessions").delete().lt("expires_at", new Date(now).toISOString());
  const secret = randomBytes(32).toString("hex");
  const expiresAt = new Date(now + DISCOVERY_SESSION_TTL_MS).toISOString();
  const inserted = await admin.from("facebook_group_discovery_sessions").insert({
    token_hash: hashSecret(secret),
    device_id: deviceId,
    candidates,
    expires_at: expiresAt,
  }).select("id").single();
  if (inserted.error || !inserted.data?.id) throw new Error(`DISCOVERY_SESSION_CREATE_FAILED: ${inserted.error?.message ?? "no id returned"}`);
  return { token: `${inserted.data.id}.${secret}`, expiresAt };
}

/**
 * Resolves an opaque token to its session, or null for any invalid, wrong,
 * or expired token -- callers must treat null as "reject", never fall back
 * to any other data. Rejects on expiry even if the row still physically
 * exists (cleanup is opportunistic, not immediate).
 */
export async function resolveDiscoverySessionToken(token: string): Promise<DiscoverySession | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const admin = createFacebookWatcherAdminClient();
  const result = await admin.from("facebook_group_discovery_sessions").select("id,token_hash,candidates,expires_at,consumed_at").eq("id", parsed.id).maybeSingle();
  if (result.error || !result.data) return null;
  const storedHash = typeof result.data.token_hash === "string" ? result.data.token_hash : "";
  if (!constantTimeHashEqual(hashSecret(parsed.secret), storedHash)) return null;
  const expiresAt = typeof result.data.expires_at === "string" ? result.data.expires_at : "";
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null;
  return {
    id: String(result.data.id),
    candidates: Array.isArray(result.data.candidates) ? (result.data.candidates as DiscoveredFacebookGroupCandidate[]) : [],
    expiresAt,
    consumedAt: typeof result.data.consumed_at === "string" ? result.data.consumed_at : null,
  };
}

/**
 * Marks a session consumed the first time an import is attempted against
 * it. This is an audit trail, not a hard single-use lock: the real
 * duplicate-prevention guarantee lives in watched_facebook_groups' own
 * unique(url) constraint, so re-using an already-consumed-but-not-yet-
 * expired token to retry a partially-failed import is intentionally still
 * possible -- rejecting it would defeat "make safe retry possible" without
 * adding any real safety, since retried imports of an already-imported
 * candidate are already rejected as duplicates by addWatchedFacebookGroup.
 */
export async function markDiscoverySessionConsumed(sessionId: string): Promise<void> {
  const admin = createFacebookWatcherAdminClient();
  await admin.from("facebook_group_discovery_sessions").update({ consumed_at: new Date().toISOString() }).eq("id", sessionId).is("consumed_at", null);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function parseToken(token: string): { id: string; secret: string } | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  return { id, secret };
}

function constantTimeHashEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(b)) return false;
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
