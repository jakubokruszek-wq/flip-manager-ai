import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

import { sha256 } from "@/features/collector/facebook-normalization";
import { createAdminClient } from "@/lib/supabase/admin";

export type CollectorDevice = { id: string; deviceName: string; lastUsedAt: string | null; revokedAt: string | null };

export async function registerCollectorDevice(input: {
  deviceName: string;
  installationId: string;
}): Promise<{ deviceId: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("collector_devices")
    .insert({
      device_name: input.deviceName,
      installation_id: input.installationId,
      token_hash: sha256(token),
    })
    .select("id")
    .single();

  if (error || !isRecord(data) || typeof data.id !== "string") {
    if (error?.code === "23505") {
      throw new CollectorAuthError(409, "To urządzenie zostało już sparowane. Usuń jego token przed ponownym parowaniem.");
    }
    console.error("COLLECTOR DEVICE REGISTER ERROR:", error);
    throw new CollectorAuthError(500, "Nie udało się zarejestrować urządzenia.");
  }

  return { deviceId: data.id, token };
}

export async function authenticateCollectorDevice(token: string): Promise<CollectorDevice> {
  const hash = sha256(token);
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("collector_devices")
    .select("id,device_name,last_used_at,revoked_at,token_hash")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error || !isRecord(data) || typeof data.id !== "string" || typeof data.token_hash !== "string") {
    throw new CollectorAuthError(401, "Token urządzenia jest nieprawidłowy.");
  }

  const expected = Buffer.from(data.token_hash, "utf8");
  const actual = Buffer.from(hash, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new CollectorAuthError(401, "Token urządzenia jest nieprawidłowy.");
  }

  if (typeof data.revoked_at === "string" && data.revoked_at) {
    throw new CollectorAuthError(401, "Token urządzenia został unieważniony.");
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabase.from("collector_devices").update({ last_used_at: now }).eq("id", data.id);
  if (updateError) throw new CollectorAuthError(500, "Nie udało się odświeżyć statusu urządzenia.");
  return { id: data.id, deviceName: typeof data.device_name === "string" ? data.device_name : "Urządzenie", lastUsedAt: now, revokedAt: typeof data.revoked_at === "string" ? data.revoked_at : null };
}

export async function revokeCollectorDevice(token: string): Promise<void> {
  const device = await authenticateCollectorDevice(token);
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("collector_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", device.id);

  if (error) {
    console.error("COLLECTOR DEVICE REVOKE ERROR:", error);
    throw new CollectorAuthError(500, "Nie udało się unieważnić tokenu urządzenia.");
  }
}

export class CollectorAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
