import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { androidLeaseInput, claimAndroidJob, heartbeatAndroidJob, completeAndroidJob } from "./jobs.ts";
import { MockAndroidStore, jobRow, completionPayload, DEVICE, OTHER_DEVICE, SOURCE_SCAN } from "./fixtures.test-support.ts";

function run(store: MockAndroidStore, value = completionPayload(store.jobs[0]), processBatch = async () => ({ status: "completed" })) {
  return completeAndroidJob({ store, deviceId: DEVICE, value, rawBody: JSON.stringify(value), processBatch });
}
test("claim returns only source scans for Android and never steals extension work", async () => {
  const store = new MockAndroidStore([jobRow({ id: "browser", consumer_type: "BROWSER_EXTENSION", status: "queued" }), jobRow({ id: "gallery", job_type: "GALLERY_HYDRATION", status: "queued" }), jobRow({ status: "queued", worker_id: "", attempts: 0 })]);
  const job = await claimAndroidJob(store, DEVICE);
  assert.equal(job?.consumerType, "ANDROID_WEBVIEW"); assert.equal(job?.imageMode, "SOURCE_SCAN_DATA_ONLY");
  assert.equal(store.jobs[0].status, "queued"); assert.equal(store.jobs[1].status, "queued");
});
test("parallel polls from one device reuse one lease; another device cannot claim it", async () => {
  const store = new MockAndroidStore([jobRow({ status: "queued", worker_id: "", attempts: 0 })]);
  const claims = await Promise.all(Array.from({ length: 12 }, () => claimAndroidJob(store, DEVICE)));
  assert.equal(new Set(claims.map(j => j?.leaseToken)).size, 1); assert.equal(store.jobs[0].attempts, 1);
  assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null);
});
test("expired leases rotate tokens; old owner cannot heartbeat or complete", async () => {
  const job = jobRow({ leased_until: new Date(0).toISOString() }); const store = new MockAndroidStore([job]); const old = completionPayload(job);
  assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null); store.now += 31_000;
  assert.ok(await claimAndroidJob(store, OTHER_DEVICE));
  await assert.rejects(run(store, old), /ANDROID_JOB_LEASE_LOST/);
  await assert.rejects(heartbeatAndroidJob(store, DEVICE, old), /ANDROID_JOB_LEASE_LOST/);
});
test("heartbeat rejects wrong owner, token, consumer, terminal and expired jobs", async () => {
  for (const extra of [{ worker_id: OTHER_DEVICE }, { consumer_type: "BROWSER_EXTENSION" }, { status: "completed" }, { leased_until: new Date(0).toISOString() }]) {
    const store = new MockAndroidStore([jobRow(extra)]);
    await assert.rejects(heartbeatAndroidJob(store, DEVICE, completionPayload(store.jobs[0])), /ANDROID_JOB_LEASE_LOST/);
  }
  const store = new MockAndroidStore(); const value = { ...completionPayload(), leaseToken: "88888888-8888-4888-8888-888888888888" };
  await assert.rejects(heartbeatAndroidJob(store, DEVICE, value), /ANDROID_JOB_LEASE_LOST/);
});
test("valid heartbeat uses the Android RPC and returns the renewed deadline", async () => {
  const store = new MockAndroidStore(); store.now += 45_000;
  assert.equal(await heartbeatAndroidJob(store, DEVICE, completionPayload(store.jobs[0])), new Date(store.now + 180_000).toISOString());
});
test("same completion returns a durable receipt without a second import", async () => {
  const store = new MockAndroidStore(); const value = completionPayload(); let calls = 0;
  const process = async () => { calls++; return { status: "completed" }; };
  const first = await run(store, value, process); const second = await run(store, value, process);
  assert.deepEqual(second, first); assert.equal(calls, 1);
});
test("concurrent completions reserve import once", async () => {
  const store = new MockAndroidStore(); const value = completionPayload(); let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = run(store, value, async () => { calls++; await gate; return { status: "completed" }; });
  // Wait until the first call crossed the durable reservation boundary.
  while (!store.reservations.size) await Promise.resolve();
  await assert.rejects(run(store, value), /ANDROID_COMPLETION_IN_PROGRESS/);
  release(); await first; assert.equal(calls, 1);
});
test("changed completion body or ID conflicts with the first reservation", async () => {
  const store = new MockAndroidStore(); const value = completionPayload(); await run(store, value);
  await assert.rejects(run(store, { ...value, extra: true } as typeof value), /ANDROID_COMPLETION_CONFLICT/);
});
test("crashed import stays fenced after lease expiry", async () => {
  const store = new MockAndroidStore(); const value = completionPayload(); let calls = 0;
  await assert.rejects(run(store, value, async () => { calls++; throw Error("simulated crash"); }), /simulated crash/);
  store.now += 600_000;
  assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null);
  await assert.rejects(run(store, value), /ANDROID_COMPLETION_IN_PROGRESS/); assert.equal(calls, 1);
});
test("mismatched run, source, mode or batch ID is rejected before reservation", async () => {
  for (const patch of [{ scanId: SOURCE_SCAN }, { sourceId: "other-group", sourceUrl: "https://www.facebook.com/groups/other-group/" }, { imageMode: "GALLERY_HYDRATION_MEDIA_ALLOWED" }, { batchId: SOURCE_SCAN }]) {
    const store = new MockAndroidStore(); const value = completionPayload(); Object.assign(value.batch, patch);
    await assert.rejects(run(store, value)); assert.equal(store.reservations.size, 0);
  }
});
test("too many posts and malformed IDs are rejected without truncation", async () => {
  assert.throws(() => androidLeaseInput({ jobId: "bad", leaseToken: "bad" }), /INVALID_PAYLOAD/);
  const store = new MockAndroidStore(); const value = completionPayload(); value.batch.posts = new Array(151).fill({});
  await assert.rejects(run(store, value), /INVALID_PAYLOAD/);
});
test("import is bound to the claimed source scan, and preserves normalizer deduplication", async () => {
  const store = new MockAndroidStore(); const value = completionPayload(); const post = { postId: "123456789", permalink: "https://www.facebook.com/groups/mock-group/posts/123456789/", sourceId: "mock-group", sourceType: "GROUP", text: "Sprzedam mieszkanie 50 m2 za 300000 zł", author: "Mock Author", publishedAt: new Date().toISOString(), identityConfidence: "EXACT", discoveryLayers: ["DOM"], media: [] };
  Object.assign(value.batch, { posts: [post, post] }); value.batch.health.capturedPostCount = 1; value.batch.health.visibleCardCount = 1;
  await completeAndroidJob({ store, deviceId: DEVICE, value, rawBody: JSON.stringify(value), processBatch: async (deviceId, batch, context) => {
    assert.equal(deviceId, DEVICE); assert.equal(context.sourceScanId, SOURCE_SCAN); assert.equal(batch.posts.length, 1); return { status: "completed" };
  } });
});
test("reported collector failures finish safely without processing a batch", async () => {
  const store = new MockAndroidStore(); const job = store.jobs[0]; let calls = 0;
  const value = { jobId: job.id, leaseToken: job.lease_token, completionId: "33333333-3333-4333-8333-333333333333", dataMode: "LIVE", status: "failed", errorCode: "LOGIN_REQUIRED" };
  const result = await completeAndroidJob({ store, deviceId: DEVICE, value, rawBody: JSON.stringify(value), processBatch: async () => { calls++; return { status: "completed" }; } });
  assert.equal(result.status, "failed"); assert.equal(calls, 0);
});
test("backend failures never masquerade as lease loss or successful claims", async () => {
  const store = new MockAndroidStore(); store.unavailable = true;
  await assert.rejects(claimAndroidJob(store, DEVICE), /ANDROID_QUEUE_UNAVAILABLE/);
});
test("SQL draft has service-only invoker RPCs and excludes reserved imports from recovery", () => {
  const sql = readFileSync("supabase/drafts/android-webview-backend.sql", "utf8");
  assert.equal((sql.match(/security invoker/g) ?? []).length, 4); assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /for update skip locked/i); assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /j\.android_completion_state is null/); assert.match(sql, /j\.leased_until > clock_timestamp\(\)/);
  assert.equal((sql.match(/revoke all on function[^;]+from public, anon, authenticated/g) ?? []).length, 4);
});
test("manual cancellation settles once without importing and cannot override an existing completion", async () => {
  const store = new MockAndroidStore(); const j = store.jobs[0]; let imports = 0;
  const value = { jobId:j.id, leaseToken:j.lease_token, completionId:completionPayload().completionId, dataMode:"LIVE", status:"cancelled" };
  const send = () => completeAndroidJob({store,deviceId:DEVICE,value,rawBody:JSON.stringify(value),processBatch:async()=>{imports++;return {status:"completed"};}});
  const first=await send(); assert.equal(first.status,"failed"); assert.deepEqual(first.result,{cancelled:true});
  assert.deepEqual(await send(),first); assert.equal(imports,0);
  const changed={...value,status:"completed",batch:completionPayload().batch};
  await assert.rejects(completeAndroidJob({store,deviceId:DEVICE,value:changed,rawBody:JSON.stringify(changed),processBatch:async()=>({status:"completed"})}), /ANDROID_COMPLETION_CONFLICT/);
});

test("a completion reserved before expiry can finish after expiry without replacement", async () => {
  const store = new MockAndroidStore(); const value = completionPayload();
  const result = await run(store, value, async () => {
    store.now += 600_000; assert.equal(await claimAndroidJob(store, OTHER_DEVICE), null); return { status: "completed" };
  });
  assert.equal(result.status, "completed");
});
test("terminal jobs without receipts, exhausted leases and browser jobs cannot be completed", async () => {
  for (const extra of [{ status: "completed" }, { leased_until: new Date(0).toISOString(), attempts: 3 }, { consumer_type: "BROWSER_EXTENSION" }]) {
    const store = new MockAndroidStore([jobRow(extra)]);
    await assert.rejects(run(store), /ANDROID_JOB_LEASE_LOST/);
  }
});
test("batch processing failure produces failed terminal receipt", async () => {
  const store = new MockAndroidStore(); const result = await run(store, completionPayload(), async () => ({ status: "failed" }));
  assert.equal(result.status, "failed"); assert.equal(store.jobs[0].status, "failed");
});
