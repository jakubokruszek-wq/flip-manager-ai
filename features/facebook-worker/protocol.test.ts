import assert from "node:assert/strict";
import test from "node:test";
import { createFacebookWorkerAuthHeaders, FACEBOOK_WORKER_NONCE_HEADER, FACEBOOK_WORKER_SIGNATURE_HEADER, FACEBOOK_WORKER_TIMESTAMP_HEADER, verifyFacebookWorkerAuth } from "./protocol.ts";

const secret = "facebook-worker-test-secret-at-least-32-characters";
const now = Date.parse("2026-08-11T12:00:00Z");

function headers(signature = true, timestamp = now) {
  const auth = createFacebookWorkerAuthHeaders({ secret, method: "POST", pathname: "/api/facebook-worker/claim", body: "{}", now: timestamp, nonce: "nonce-1" });
  return new Headers({ [FACEBOOK_WORKER_TIMESTAMP_HEADER]: auth.timestamp, [FACEBOOK_WORKER_NONCE_HEADER]: auth.nonce, [FACEBOOK_WORKER_SIGNATURE_HEADER]: signature ? auth.signature : "0".repeat(64) });
}

test("accepts a valid Facebook worker HMAC", async () => {
  const result = await verifyFacebookWorkerAuth({ secret, method: "POST", pathname: "/api/facebook-worker/claim", body: "{}", headers: headers(), now, useNonce: async () => true });
  assert.equal(result.ok, true);
});

test("rejects invalid signature", async () => {
  const result = await verifyFacebookWorkerAuth({ secret, method: "POST", pathname: "/api/facebook-worker/claim", body: "{}", headers: headers(false), now, useNonce: async () => true });
  assert.deepEqual(result, { ok: false, code: "INVALID_SIGNATURE" });
});

test("rejects expired timestamp", async () => {
  const result = await verifyFacebookWorkerAuth({ secret, method: "POST", pathname: "/api/facebook-worker/claim", body: "{}", headers: headers(true, now - 301_000), now, useNonce: async () => true });
  assert.deepEqual(result, { ok: false, code: "EXPIRED_REQUEST" });
});

test("rejects replayed nonce", async () => {
  const result = await verifyFacebookWorkerAuth({ secret, method: "POST", pathname: "/api/facebook-worker/claim", body: "{}", headers: headers(), now, useNonce: async () => false });
  assert.deepEqual(result, { ok: false, code: "REPLAYED_NONCE" });
});

