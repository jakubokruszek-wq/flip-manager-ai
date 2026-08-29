import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "flip_collector_pairing";
const TTL_SECONDS = 120;

export function pairingCookieName(): string { return COOKIE; }

export function createPairingChallenge(): { challenge: string; cookie: string; maxAge: number } {
  const challenge = randomBytes(24).toString("base64url");
  const payload = `${challenge}.${Date.now() + TTL_SECONDS * 1000}`;
  return { challenge, cookie: `${payload}.${sign(payload)}`, maxAge: TTL_SECONDS };
}

export function verifyPairingChallenge(value: string | null, challenge: string): boolean {
  if (!value || !challenge) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== challenge) return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return safeEquals(parts[2], sign(`${parts[0]}.${parts[1]}`));
}

function sign(value: string): string {
  const secret = process.env.FLIP_COLLECTOR_PAIRING_SECRET;
  if (!secret) throw new Error("COLLECTOR_PAIRING_NOT_CONFIGURED");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
