import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const COLLECTOR_DEVICE_HEADER = "x-flip-collector-device-id";
export const COLLECTOR_TIMESTAMP_HEADER = "x-flip-collector-timestamp";
export const COLLECTOR_NONCE_HEADER = "x-flip-collector-nonce";
export const COLLECTOR_SIGNATURE_HEADER = "x-flip-collector-signature";
export const COLLECTOR_CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;

export type CollectorAuthHeaders = { deviceId: string; timestamp: string; nonce: string; signature: string };
export type CollectorAuthResult =
  | { ok: true; deviceId: string; timestamp: number; nonce: string }
  | { ok: false; code: "MISSING_AUTH" | "INVALID_TIMESTAMP" | "EXPIRED_TIMESTAMP" | "INVALID_NONCE" | "INVALID_SIGNATURE" | "REPLAYED_NONCE" };

export function collectorSigningKey(deviceToken: string): string {
  return createHash("sha256").update(deviceToken).digest("hex");
}

export function createCollectorAuthHeaders(input: {
  deviceId: string;
  deviceToken: string;
  method: string;
  pathname: string;
  body: string;
  now?: number;
  nonce?: string;
}): CollectorAuthHeaders {
  const timestamp = String(input.now ?? Date.now());
  const nonce = input.nonce ?? randomUUID();
  return {
    deviceId: input.deviceId,
    timestamp,
    nonce,
    signature: signCollectorRequest({ signingKey: collectorSigningKey(input.deviceToken), method: input.method, pathname: input.pathname, body: input.body, timestamp, nonce }),
  };
}

export async function verifyCollectorAuth(input: {
  signingKey: string;
  method: string;
  pathname: string;
  body: string;
  headers: Headers;
  now?: number;
  useNonce: (nonce: string, expiresAt: number) => Promise<boolean>;
}): Promise<CollectorAuthResult> {
  const deviceId = input.headers.get(COLLECTOR_DEVICE_HEADER)?.trim();
  const timestampText = input.headers.get(COLLECTOR_TIMESTAMP_HEADER)?.trim();
  const nonce = input.headers.get(COLLECTOR_NONCE_HEADER)?.trim();
  const signature = input.headers.get(COLLECTOR_SIGNATURE_HEADER)?.trim().toLowerCase();
  if (!deviceId || !timestampText || !nonce || !signature) return { ok: false, code: "MISSING_AUTH" };
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return { ok: false, code: "INVALID_TIMESTAMP" };
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestamp) > COLLECTOR_CLOCK_TOLERANCE_MS) return { ok: false, code: "EXPIRED_TIMESTAMP" };
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, code: "INVALID_NONCE" };
  if (!/^[a-f0-9]{64}$/.test(signature)) return { ok: false, code: "INVALID_SIGNATURE" };
  const expected = signCollectorRequest({ signingKey: input.signingKey, method: input.method, pathname: input.pathname, body: input.body, timestamp: timestampText, nonce });
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(signature, "hex");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return { ok: false, code: "INVALID_SIGNATURE" };
  const accepted = await input.useNonce(nonce, timestamp + COLLECTOR_CLOCK_TOLERANCE_MS);
  return accepted ? { ok: true, deviceId, timestamp, nonce } : { ok: false, code: "REPLAYED_NONCE" };
}

export function signCollectorRequest(input: { signingKey: string; method: string; pathname: string; body: string; timestamp: string; nonce: string }): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const canonical = [input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, bodyHash].join("\n");
  return createHmac("sha256", input.signingKey).update(canonical).digest("hex");
}
