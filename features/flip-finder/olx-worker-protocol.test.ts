import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
  verifyWorkerAuth,
} from "./olx-worker-protocol.ts";

const secret = "test-secret-with-enough-entropy";
const body = JSON.stringify({ workerId: "windows-1" });

function headers(now: number, nonce = "nonce-1") {
  const auth = createWorkerAuthHeaders({ secret, method: "POST", pathname: "/api/olx-worker/claim", body, now, nonce });
  return new Headers({
    [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp,
    [OLX_WORKER_NONCE_HEADER]: auth.nonce,
    [OLX_WORKER_SIGNATURE_HEADER]: auth.signature,
  });
}

test("accepts a valid HMAC and rejects replayed nonce", async () => {
  const used = new Set<string>();
  const useNonce = async (nonce: string) => !used.has(nonce) && Boolean(used.add(nonce));
  const now = Date.parse("2026-08-10T12:00:00Z");
  const first = await verifyWorkerAuth({ secret, method: "POST", pathname: "/api/olx-worker/claim", body, headers: headers(now), now, useNonce });
  const replay = await verifyWorkerAuth({ secret, method: "POST", pathname: "/api/olx-worker/claim", body, headers: headers(now), now, useNonce });
  assert.equal(first.ok, true);
  assert.deepEqual(replay, { ok: false, code: "REPLAYED_NONCE" });
});

test("rejects changed body and expired timestamp", async () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  const useNonce = async () => true;
  const changed = await verifyWorkerAuth({ secret, method: "POST", pathname: "/api/olx-worker/claim", body: "{}", headers: headers(now), now, useNonce });
  const expired = await verifyWorkerAuth({ secret, method: "POST", pathname: "/api/olx-worker/claim", body, headers: headers(now - 600_000, "nonce-2"), now, useNonce });
  assert.deepEqual(changed, { ok: false, code: "INVALID_SIGNATURE" });
  assert.deepEqual(expired, { ok: false, code: "EXPIRED_REQUEST" });
});
