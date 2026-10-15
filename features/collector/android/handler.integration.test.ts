import assert from "node:assert/strict";
import test from "node:test";
import { handleAndroidRequest, ANDROID_BODY_LIMIT_BYTES, type AndroidAction } from "./handler.ts";
import { AndroidJobError } from "./jobs.ts";
import { createCollectorAuthHeaders, collectorSigningKey, verifyCollectorAuth } from "../protocol.ts";
import { MockAndroidStore, jobRow, completionPayload, DEVICE, OTHER_DEVICE } from "./fixtures.test-support.ts";

const TOKEN = "mock-device-token";
function harness() {
  const store = new MockAndroidStore([jobRow({ status: "queued", worker_id: "", attempts: 0 })]);
  const nonces = new Set<string>(); let enabled = true; let imports = 0;
  const devices = new Map([[DEVICE, { type: "ANDROID_WEBVIEW", revoked: false }], [OTHER_DEVICE, { type: "BROWSER_EXTENSION", revoked: false }]]);
  const deps = {
    enabled: () => enabled, store: () => store,
    processBatch: async () => { imports++; return { status: "completed" }; },
    authenticate: async (request: Request, pathname: string, body: string) => {
      const deviceId = request.headers.get("x-flip-collector-device-id")!; const device = devices.get(deviceId);
      if (!device || device.revoked) throw new AndroidJobError(401, "INVALID_DEVICE");
      if (device.type !== "ANDROID_WEBVIEW") throw new AndroidJobError(403, "COLLECTOR_CONSUMER_MISMATCH");
      const auth = await verifyCollectorAuth({ signingKey: collectorSigningKey(TOKEN), method: request.method, pathname, body, headers: request.headers,
        useNonce: async nonce => { const key = deviceId + nonce; if (nonces.has(key)) return false; nonces.add(key); return true; } });
      if (!auth.ok) throw new AndroidJobError(401, auth.code);
      return deviceId;
    },
  };
  function request(action: AndroidAction, value: unknown, options: { nonce?: string; deviceId?: string; now?: number; signedAction?: AndroidAction; rawBody?: string } = {}) {
    const body = options.rawBody ?? JSON.stringify(value); const auth = createCollectorAuthHeaders({ deviceId: options.deviceId ?? DEVICE, deviceToken: TOKEN, method: "POST", pathname: `/api/collector/android/jobs/${options.signedAction ?? action}`, body, now: options.now, nonce: options.nonce });
    return new Request(`https://example.invalid/api/collector/android/jobs/${action}`, { method: "POST", body, headers: { "content-type": "application/json", "x-flip-collector-device-id": auth.deviceId, "x-flip-collector-timestamp": auth.timestamp, "x-flip-collector-nonce": auth.nonce, "x-flip-collector-signature": auth.signature } });
  }
  return { store, devices, request, send: (action: AndroidAction, req: Request) => handleAndroidRequest(req, action, deps), disable: () => { enabled = false; }, imports: () => imports };
}
test("signed mock HTTP flow: claim, renew, import and retry with fresh nonce", async () => {
  const h = harness(); const claim = await h.send("claim", h.request("claim", {}));
  assert.equal(claim.status, 200); assert.equal(claim.headers.get("cache-control"), "no-store");
  const { job } = await claim.json(); assert.ok(job); assert.equal(job.consumerType, "ANDROID_WEBVIEW");
  assert.equal((await h.send("heartbeat", h.request("heartbeat", { jobId: job.id, leaseToken: job.leaseToken }))).status, 200);
  const value = completionPayload(h.store.jobs[0]);
  const first = await h.send("complete", h.request("complete", value));
  assert.equal(first.status, 200); const receipt = await first.json();
  const second = await h.send("complete", h.request("complete", value));
  assert.deepEqual(await second.json(), receipt); assert.equal(h.imports(), 1);
});
test("replayed HMAC nonce is rejected before queue access", async () => {
  const h = harness(); const req = h.request("claim", {}, { nonce: "replay_nonce_123456789" });
  assert.equal((await h.send("claim", req.clone())).status, 200); const calls = h.store.calls.length;
  const replay = await h.send("claim", req); assert.equal(replay.status, 401); assert.equal((await replay.json()).code, "REPLAYED_NONCE"); assert.equal(h.store.calls.length, calls);
});
test("DEMO and offline-test imports cannot reach the live import pipeline", async () => {
  const h=harness(); await h.send("claim",h.request("claim",{}));
  for (const mode of ["DEMO","OFFLINE_TEST",null]) {
    const value={...completionPayload(h.store.jobs[0]),dataMode:mode};
    const response=await h.send("complete",h.request("complete",value));
    assert.equal(response.status,422);assert.equal((await response.json()).code,"ANDROID_DATA_DOMAIN_MISMATCH");
  }
  assert.equal(h.imports(),0);assert.equal(h.store.reservations.size,0);
});
test("signature cannot be replayed on a different Android endpoint", async () => {
  const h = harness(); const response = await h.send("claim", h.request("claim", {}, { signedAction: "complete" }));
  assert.equal(response.status, 401); assert.equal((await response.json()).code, "INVALID_SIGNATURE");
});
test("expired signatures, revoked devices and extension devices cannot claim Android jobs", async () => {
  const h = harness(); assert.equal((await h.send("claim", h.request("claim", {}, { now: Date.now() - 600_000 }))).status, 401);
  assert.equal((await h.send("claim", h.request("claim", {}, { deviceId: OTHER_DEVICE }))).status, 403);
  h.devices.get(DEVICE)!.revoked = true; assert.equal((await h.send("claim", h.request("claim", {}))).status, 401); assert.equal(h.store.calls.length, 0);
});
test("disabled Android queue stops claims while allowing leased work to drain", async () => {
  const h = harness(); await h.send("claim", h.request("claim", {})); h.disable();
  const response = await h.send("claim", h.request("claim", {})); assert.equal((await response.json()).code, "ANDROID_QUEUE_DISABLED");
  const value = completionPayload(h.store.jobs[0]); assert.equal((await h.send("heartbeat", h.request("heartbeat", value))).status, 200);
  assert.equal((await h.send("complete", h.request("complete", value))).status, 200);
});
test("invalid JSON, null body and invalid lease return 400 without import", async () => {
  const h = harness();
  for (const rawBody of ["{", "null", "[]"]) assert.equal((await h.send("complete", h.request("complete", null, { rawBody }))).status, 400);
  assert.equal((await h.send("heartbeat", h.request("heartbeat", {}))).status, 400); assert.equal(h.imports(), 0);
});
test("body limit is enforced from actual streamed bytes without Content-Length", async () => {
  const h = harness(); const response = await h.send("complete", new Request("https://example.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(ANDROID_BODY_LIMIT_BYTES + 1) }));
  assert.equal(response.status, 413); assert.equal(h.store.calls.length, 0);
});
test("queue failures return sanitized 503, unsupported payload types return 415", async () => {
  const h = harness(); h.store.unavailable = true;
  const failed = await h.send("claim", h.request("claim", {})); assert.equal(failed.status, 503); assert.equal((await failed.json()).code, "ANDROID_QUEUE_UNAVAILABLE");
  const req = h.request("claim", {}); req.headers.set("content-type", "text/plain"); assert.equal((await h.send("claim", req)).status, 415);
});

test("signed status lookup shows owned completion without exposing its lease token", async () => {
  const h = harness(); await h.send("claim", h.request("claim", {})); const value = completionPayload(h.store.jobs[0]);
  const response = await h.send("status", h.request("status", value));
  assert.equal(response.status, 200); const status = await response.json(); assert.equal(status.completionState, "NONE"); assert.equal("leaseToken" in status, false);
  const expiredSignature = await h.send("status", h.request("status", value, { signedAction: "complete" })); assert.equal(expiredSignature.status, 401);
});
