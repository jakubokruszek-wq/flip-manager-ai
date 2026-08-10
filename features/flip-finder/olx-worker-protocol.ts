import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const OLX_WORKER_TIMESTAMP_HEADER = "x-olx-worker-timestamp";
export const OLX_WORKER_NONCE_HEADER = "x-olx-worker-nonce";
export const OLX_WORKER_SIGNATURE_HEADER = "x-olx-worker-signature";
export const OLX_WORKER_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export type WorkerAuthHeaders = {
  timestamp: string;
  nonce: string;
  signature: string;
};

export type WorkerAuthResult =
  | { ok: true; timestamp: number; nonce: string }
  | { ok: false; code: "MISSING_AUTH" | "INVALID_TIMESTAMP" | "EXPIRED_REQUEST" | "INVALID_SIGNATURE" | "REPLAYED_NONCE" };

export function createWorkerAuthHeaders(input: {
  secret: string;
  method: string;
  pathname: string;
  body: string;
  now?: number;
  nonce?: string;
}): WorkerAuthHeaders {
  const timestamp = String(input.now ?? Date.now());
  const nonce = input.nonce ?? randomUUID();
  return {
    timestamp,
    nonce,
    signature: signWorkerRequest({ ...input, timestamp, nonce }),
  };
}

export async function verifyWorkerAuth(input: {
  secret: string;
  method: string;
  pathname: string;
  body: string;
  headers: Headers;
  now?: number;
  useNonce: (nonce: string, expiresAt: number) => Promise<boolean>;
}): Promise<WorkerAuthResult> {
  const timestampText = input.headers.get(OLX_WORKER_TIMESTAMP_HEADER);
  const nonce = input.headers.get(OLX_WORKER_NONCE_HEADER);
  const signature = input.headers.get(OLX_WORKER_SIGNATURE_HEADER);
  if (!timestampText || !nonce || !signature) return { ok: false, code: "MISSING_AUTH" };
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp)) return { ok: false, code: "INVALID_TIMESTAMP" };
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestamp) > OLX_WORKER_CLOCK_TOLERANCE_MS) return { ok: false, code: "EXPIRED_REQUEST" };
  const expected = signWorkerRequest({ ...input, timestamp: timestampText, nonce });
  if (!safeEqualHex(expected, signature)) return { ok: false, code: "INVALID_SIGNATURE" };
  const accepted = await input.useNonce(nonce, timestamp + OLX_WORKER_CLOCK_TOLERANCE_MS);
  return accepted ? { ok: true, timestamp, nonce } : { ok: false, code: "REPLAYED_NONCE" };
}

function signWorkerRequest(input: {
  secret: string;
  method: string;
  pathname: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const canonical = [input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, bodyHash].join("\n");
  return createHmac("sha256", input.secret).update(canonical).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
