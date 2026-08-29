import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_DEVICE_HEADER,
  COLLECTOR_NONCE_HEADER,
  COLLECTOR_SIGNATURE_HEADER,
  COLLECTOR_TIMESTAMP_HEADER,
  createCollectorAuthHeaders,
  verifyCollectorAuth,
} from "./protocol.ts";

const deviceId = "11111111-1111-4111-8111-111111111111";
const deviceToken = "collector-device-token-with-enough-entropy";
const body = JSON.stringify({ batchId: "batch-1" });
const pathname = "/api/collector/facebook/batches";

function requestHeaders(now: number, nonce = "nonce_1234567890") {
  const auth = createCollectorAuthHeaders({ deviceId, deviceToken, method: "POST", pathname, body, now, nonce });
  return new Headers({
    [COLLECTOR_DEVICE_HEADER]: auth.deviceId,
    [COLLECTOR_TIMESTAMP_HEADER]: auth.timestamp,
    [COLLECTOR_NONCE_HEADER]: auth.nonce,
    [COLLECTOR_SIGNATURE_HEADER]: auth.signature,
  });
}

test("collector HMAC accepts a valid request and rejects replay", async () => {
  const now = Date.now();
  const used = new Set<string>();
  const useNonce = async (nonce: string) => !used.has(nonce) && Boolean(used.add(nonce));
  const valid = await verifyCollectorAuth({ signingKey: await sha256(deviceToken), method: "POST", pathname, body, headers: requestHeaders(now), now, useNonce });
  assert.equal(valid.ok, true);
  const replay = await verifyCollectorAuth({ signingKey: await sha256(deviceToken), method: "POST", pathname, body, headers: requestHeaders(now), now, useNonce });
  assert.deepEqual(replay, { ok: false, code: "REPLAYED_NONCE" });
});

test("collector HMAC rejects tampering, expiry, and missing auth", async () => {
  const now = Date.now();
  const useNonce = async () => true;
  const invalid = await verifyCollectorAuth({ signingKey: await sha256(deviceToken), method: "POST", pathname, body: `${body}x`, headers: requestHeaders(now), now, useNonce });
  assert.deepEqual(invalid, { ok: false, code: "INVALID_SIGNATURE" });
  const expired = await verifyCollectorAuth({ signingKey: await sha256(deviceToken), method: "POST", pathname, body, headers: requestHeaders(now - 600_000, "nonce_1234567891"), now, useNonce });
  assert.deepEqual(expired, { ok: false, code: "EXPIRED_TIMESTAMP" });
  const missing = await verifyCollectorAuth({ signingKey: await sha256(deviceToken), method: "POST", pathname, body, headers: new Headers(), now, useNonce });
  assert.deepEqual(missing, { ok: false, code: "MISSING_AUTH" });
});

async function sha256(value: string): Promise<string> {
  return (await import("node:crypto")).createHash("sha256").update(value).digest("hex");
}
