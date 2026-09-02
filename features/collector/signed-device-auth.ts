import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  COLLECTOR_DEVICE_HEADER,
  verifyCollectorAuth,
  type CollectorAuthResult,
} from "./protocol";
import { collectorDeviceActivityPatch } from "./device-heartbeat";

export type SignedCollectorDevice = { id: string; deviceName: string; signingKey: string };

export async function authenticateSignedCollectorRequest(input: {
  request: Request;
  pathname: string;
  body: string;
  now?: number;
  markHealthy?: boolean;
}): Promise<{ device: SignedCollectorDevice; auth: Extract<CollectorAuthResult, { ok: true }> }> {
  const deviceId = input.request.headers.get(COLLECTOR_DEVICE_HEADER)?.trim();
  if (!deviceId) throw new SignedCollectorAuthError(401, "MISSING_AUTH");
  const supabase = createAdminClient();
  const deviceResult = await supabase.from("collector_devices").select("id,device_name,token_hash,revoked_at").eq("id", deviceId).maybeSingle();
  const row = record(deviceResult.data);
  if (deviceResult.error || !row || typeof row.id !== "string" || typeof row.token_hash !== "string" || row.revoked_at) throw new SignedCollectorAuthError(401, "INVALID_DEVICE");
  const auth = await verifyCollectorAuth({
    signingKey: row.token_hash,
    method: input.request.method,
    pathname: input.pathname,
    body: input.body,
    headers: input.request.headers,
    now: input.now,
    useNonce: async (nonce, expiresAt) => {
      await supabase.from("collector_request_nonces").delete().lt("expires_at", new Date().toISOString());
      const inserted = await supabase.from("collector_request_nonces").insert({ device_id: row.id, nonce, expires_at: new Date(expiresAt).toISOString() });
      if (!inserted.error) return true;
      if (inserted.error.code === "23505") return false;
      throw new SignedCollectorAuthError(503, "NONCE_STORAGE_FAILED");
    },
  });
  if (!auth.ok) throw new SignedCollectorAuthError(401, auth.code);
  const now = new Date(input.now ?? Date.now()).toISOString();
  const updated = await supabase.from("collector_devices").update(collectorDeviceActivityPatch(now, input.markHealthy === true)).eq("id", row.id);
  if (updated.error) throw new SignedCollectorAuthError(503, "DEVICE_HEARTBEAT_FAILED");
  return { device: { id: row.id, deviceName: typeof row.device_name === "string" ? row.device_name : "Collector", signingKey: row.token_hash }, auth };
}

export class SignedCollectorAuthError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
