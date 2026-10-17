import assert from "node:assert/strict";
import test from "node:test";
import { completeAndroidJob, claimAndroidJob, heartbeatAndroidJob, readAndroidJobStatus } from "./jobs.ts";
import { MockAndroidStore, jobRow, completionPayload, DEVICE, OTHER_DEVICE, COMPLETION, RUN, SOURCE_SCAN } from "./fixtures.test-support.ts";

const binding = { deviceId: DEVICE, batchId: COMPLETION, runId: RUN, sourceScanId: SOURCE_SCAN, sourceId: "mock-group", sourceUrl: "https://www.facebook.com/groups/mock-group/" };
test("only explicit OFFLINE_TEST atomic adapters resume a reserved batch without a checkpoint", async () => {
  for (const mode of ["OFFLINE_TEST","LIVE"] as const) {
    const store=new MockAndroidStore();let calls=0;
    const value={...completionPayload(),dataMode:mode};
    const processBatch=async () => { calls++;if(calls===1)throw Error("failure before atomic import");return {status:"completed"}; };
    const send=()=>completeAndroidJob({store,deviceId:DEVICE,value,rawBody:JSON.stringify(value),expectedDataMode:mode,atomicOfflineImportReplay:true,processBatch});
    await assert.rejects(send(),/failure before atomic import/);
    if(mode==="LIVE") {
      await assert.rejects(send(),/ANDROID_COMPLETION_IN_PROGRESS/);assert.equal(calls,1);
    } else {
      const receipt=await send();assert.equal(receipt.status,"completed");assert.equal(calls,2);
      assert.deepEqual(await send(),receipt);assert.equal(calls,2);
    }
  }
});
class FaultStore extends MockAndroidStore {
  fault: { name: string; phase: "before" | "after" } | null = null;
  async rpc(name: string, args: Record<string, unknown>) {
    const fault = this.fault;
    if (fault?.name === name && fault.phase === "before") { this.fault = null; return { data: null, error: { message: "API disconnected before commit" } }; }
    const result = await super.rpc(name, args);
    if (fault?.name === name && fault.phase === "after") { this.fault = null; return { data: null, error: { message: "API response lost after commit" } }; }
    return result;
  }
}
function call(store: MockAndroidStore, value: unknown, processBatch: () => Promise<{ status: string }>) {
  return completeAndroidJob({ store, deviceId: DEVICE, value, rawBody: JSON.stringify(value), processBatch });
}
test("Wi-Fi loss before claim commit leaves work available; restored Wi-Fi resumes one lease", async () => {
  const store = new FaultStore([jobRow({ status: "queued", attempts: 0, worker_id: "" })]);
  store.fault = { name: "claim_android_facebook_scan_job", phase: "before" };
  await assert.rejects(claimAndroidJob(store, DEVICE), /ANDROID_QUEUE_UNAVAILABLE/);
  const first = await claimAndroidJob(store, DEVICE); const second = await claimAndroidJob(store, DEVICE);
  assert.equal(first?.leaseToken, second?.leaseToken); assert.equal(store.jobs[0].attempts, 1);
});
test("phone power-off rotates expired ownership only after backoff", async () => {
  const store = new MockAndroidStore([jobRow({ leased_until: new Date(0).toISOString() })]); const stale = completionPayload(store.jobs[0]);
  assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null);
  await assert.rejects(heartbeatAndroidJob(store, DEVICE, stale), /LEASE_LOST/);
  store.now += 31_000; const fresh = await claimAndroidJob(store, OTHER_DEVICE);
  assert.ok(fresh); assert.notEqual(fresh.leaseToken, stale.leaseToken);
  await assert.rejects(call(store, stale, async () => { throw Error("must not import"); }), /LEASE_LOST/);
});
test("exhausted leases fail without a fourth execution", async () => {
  const store = new MockAndroidStore([jobRow({ attempts: 3, leased_until: new Date(0).toISOString() })]);
  assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null); assert.equal(store.jobs[0].status, "failed");
});
test("lost heartbeat response can be retried by same owner without another scan", async () => {
  const store = new FaultStore(); const value = completionPayload(store.jobs[0]); store.now += 45_000;
  store.fault = { name: "renew_android_facebook_scan_job", phase: "after" };
  await assert.rejects(heartbeatAndroidJob(store, DEVICE, value), /UNAVAILABLE/);
  assert.equal(await heartbeatAndroidJob(store, DEVICE, value), store.jobs[0].leased_until); assert.equal(store.jobs[0].attempts, 1);
});
for (const phase of ["before", "after"] as const) test(`finalization API failure ${phase} commit never reruns persisted import`, async () => {
  const store = new FaultStore(); const value = completionPayload(); let imports = 0;
  store.fault = { name: "finish_android_facebook_completion", phase };
  const process = async () => { imports++; const result = { status: "completed", sourceScanIds: [SOURCE_SCAN], batchId: COMPLETION }; store.completedBatches.push({ binding, result }); return result; };
  await assert.rejects(call(store, value, process), /UNAVAILABLE/);
  const receipt = await call(store, value, process); assert.equal(receipt.status, "completed"); assert.equal(imports, 1);
  assert.deepEqual(await call(store, value, process), receipt);
});
test("concurrent checkpoint recovery shares the original receipt", async () => {
  const store = new FaultStore(); const value = completionPayload();
  store.fault = { name: "finish_android_facebook_completion", phase: "before" };
  await assert.rejects(call(store, value, async () => { store.completedBatches.push({ binding, result: { status: "completed" } }); return { status: "completed" }; }));
  const neverImport = async () => { throw Error("duplicate import"); };
  const results = await Promise.all([call(store, value, neverImport), call(store, value, neverImport)]);
  assert.deepEqual(results[0], results[1]);
});
test("ambiguous partial import stays fenced and status escalates after five minutes", async () => {
  const store = new MockAndroidStore(); const value = completionPayload();
  await assert.rejects(call(store, value, async () => { throw Error("listing saved, metadata API failed"); }));
  assert.equal((await readAndroidJobStatus(store, DEVICE, value, store.now)).completionState, "PROCESSING");
  assert.equal((await readAndroidJobStatus(store, DEVICE, value, store.now + 301_000)).completionState, "RECONCILIATION_REQUIRED");
  await assert.rejects(call(store, value, async () => ({ status: "completed" })), /IN_PROGRESS/);
  await assert.rejects(readAndroidJobStatus(store, OTHER_DEVICE, value), /LEASE_LOST/);
});
test("an unrelated checkpoint cannot finalize the reservation", async () => {
  const store = new MockAndroidStore(); const value = completionPayload();
  await assert.rejects(call(store, value, async () => { throw Error("crash"); }));
  store.completedBatches.push({ binding: { ...binding, deviceId: OTHER_DEVICE }, result: { status: "completed" } });
  await assert.rejects(call(store, value, async () => { throw Error("must not import"); }), /IN_PROGRESS/);
});
test("lost begin response for a reported scan failure can safely finish without import", async () => {
  const store = new FaultStore(); const job = store.jobs[0]; const value = { jobId: job.id, leaseToken: job.lease_token, completionId: COMPLETION, dataMode: "LIVE", status: "failed", errorCode: "WEBVIEW_STOPPED" };
  store.fault = { name: "begin_android_facebook_completion", phase: "after" };
  const neverImport = async () => { throw Error("must not import"); };
  await assert.rejects(call(store, value, neverImport), /UNAVAILABLE/);
  const receipt = await call(store, value, neverImport); assert.equal(receipt.status, "failed");
  const status = await readAndroidJobStatus(store, DEVICE, value); assert.equal(status.completionState, "SETTLED"); assert.deepEqual(status.receipt, receipt);
});

test("Android HMAC matches an independent UTF-8/hex-key test vector", async () => {
  const { createCollectorAuthHeaders, collectorSigningKey, verifyCollectorAuth } = await import("../protocol.ts");
  const body = '{\n  "label": "Łódź — test", "jobId": "55555555-5555-4555-8555-555555555555"\n}';
  const token = "android-contract-fixture-token"; const pathname = "/api/collector/android/jobs/status"; const now = 1792022400000;
  const auth = createCollectorAuthHeaders({ deviceId: DEVICE, deviceToken: token, method: "POST", pathname, body, now, nonce: "android_nonce_fixture_123456" });
  assert.equal(auth.signature, "916a61951f2ab39dd5f5e31dc77f9285ba67a4e768afa6a27cfb505c1a1e5686");
  const headers = new Headers({ "x-flip-collector-device-id": auth.deviceId, "x-flip-collector-timestamp": auth.timestamp, "x-flip-collector-nonce": auth.nonce, "x-flip-collector-signature": auth.signature });
  const altered = await verifyCollectorAuth({ signingKey: collectorSigningKey(token), method: "POST", pathname, body: body + "\n", headers, now, useNonce: async () => true });
  assert.deepEqual(altered, { ok: false, code: "INVALID_SIGNATURE" });
});
test("two simultaneous replays admit one HMAC nonce", async () => {
  const { createCollectorAuthHeaders, collectorSigningKey, verifyCollectorAuth } = await import("../protocol.ts");
  const now = Date.now(); const body = "{}"; const pathname = "/api/collector/android/jobs/claim"; const token = "test-token";
  const auth = createCollectorAuthHeaders({ deviceId: DEVICE, deviceToken: token, method: "POST", pathname, body, now });
  const headers = new Headers({ "x-flip-collector-device-id": auth.deviceId, "x-flip-collector-timestamp": auth.timestamp, "x-flip-collector-nonce": auth.nonce, "x-flip-collector-signature": auth.signature });
  const seen = new Set<string>();
  const verify = () => verifyCollectorAuth({ signingKey: collectorSigningKey(token), method: "POST", pathname, body, headers, now, useNonce: async nonce => { if (seen.has(nonce)) return false; seen.add(nonce); return true; } });
  const results = await Promise.all([verify(), verify()]); assert.equal(results.filter(r => r.ok).length, 1);
});

test("malformed persisted receipts fail closed rather than acknowledge a nonexistent success", async () => {
  const store = new MockAndroidStore([jobRow({ status: "completed", android_completion_state: "settled", android_receipt: null, leased_until: null })]);
  await assert.rejects(readAndroidJobStatus(store, DEVICE, completionPayload(store.jobs[0])), /ANDROID_RECEIPT_INVALID/);
});
