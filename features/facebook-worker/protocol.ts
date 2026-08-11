import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const FACEBOOK_WORKER_TIMESTAMP_HEADER = "x-facebook-worker-timestamp";
export const FACEBOOK_WORKER_NONCE_HEADER = "x-facebook-worker-nonce";
export const FACEBOOK_WORKER_SIGNATURE_HEADER = "x-facebook-worker-signature";
export const FACEBOOK_WORKER_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export type FacebookWorkerAuthHeaders = { timestamp: string; nonce: string; signature: string };
export type FacebookWorkerAuthResult =
  | { ok: true; timestamp: number; nonce: string }
  | { ok: false; code: "MISSING_AUTH" | "INVALID_TIMESTAMP" | "EXPIRED_REQUEST" | "INVALID_SIGNATURE" | "REPLAYED_NONCE" };

export function resolveFacebookNonceStoreResult(error: { code?: string | null } | null): boolean {
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error("NONCE_STORE_FAILED");
}

export function createFacebookWorkerAuthHeaders(input: { secret: string; method: string; pathname: string; body: string; now?: number; nonce?: string }): FacebookWorkerAuthHeaders {
  const timestamp = String(input.now ?? Date.now());
  const nonce = input.nonce ?? randomUUID();
  return { timestamp, nonce, signature: sign({ ...input, timestamp, nonce }) };
}

export async function verifyFacebookWorkerAuth(input: { secret: string; method: string; pathname: string; body: string; headers: Headers; now?: number; useNonce: (nonce: string, expiresAt: number) => Promise<boolean> }): Promise<FacebookWorkerAuthResult> {
  const timestampText = input.headers.get(FACEBOOK_WORKER_TIMESTAMP_HEADER);
  const nonce = input.headers.get(FACEBOOK_WORKER_NONCE_HEADER);
  const signature = input.headers.get(FACEBOOK_WORKER_SIGNATURE_HEADER);
  if (!timestampText || !nonce || !signature) return { ok: false, code: "MISSING_AUTH" };
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp)) return { ok: false, code: "INVALID_TIMESTAMP" };
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestamp) > FACEBOOK_WORKER_CLOCK_TOLERANCE_MS) return { ok: false, code: "EXPIRED_REQUEST" };
  const expected = sign({ ...input, timestamp: timestampText, nonce });
  if (!safeEqualHex(expected, signature)) return { ok: false, code: "INVALID_SIGNATURE" };
  const accepted = await input.useNonce(nonce, timestamp + FACEBOOK_WORKER_CLOCK_TOLERANCE_MS);
  return accepted ? { ok: true, timestamp, nonce } : { ok: false, code: "REPLAYED_NONCE" };
}

function sign(input: { secret: string; method: string; pathname: string; body: string; timestamp: string; nonce: string }): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  return createHmac("sha256", input.secret).update([input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, bodyHash].join("\n")).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

