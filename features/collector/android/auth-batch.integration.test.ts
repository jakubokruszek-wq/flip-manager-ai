import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { createCollectorAuthHeaders, collectorSigningKey } from "../protocol.ts";
import { normalizeFacebookCollectorBatch } from "../facebook-batch.ts";
import { androidDataOnlyImportActive } from "./import-policy.ts";
import { DEVICE, SOURCE_SCAN, RUN, completionPayload, jobRow } from "./fixtures.test-support.ts";

let db = new FakeFacebookSupabase();
const nonces = new Set<string>();
let nonceFailure = false;
let fallbackCalls = 0;
let importCalls = 0;
let observedAndroidDataOnly = false;
let adminCreations = 0;
let readClientOverride: FakeFacebookSupabase | null = null;
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => { adminCreations++; return readClientOverride ?? db; } } });
const admin = { from: (table: string) => {
  if (table !== "collector_request_nonces") return db.from(table);
  return {
    delete: () => ({ lt: async () => ({ error: null }) }),
    insert: async (row: { device_id: string; nonce: string }) => {
      const key = row.device_id + row.nonce;
      if (nonceFailure) return { error: { code: "XX000" } };
      if (nonces.has(key)) return { error: { code: "23505" } };
      nonces.add(key); return { error: null };
    },
  };
} };
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => admin } });
mock.module("@/features/facebook-watcher/server", { namedExports: {
  fetchFacebookActiveListingCandidates: async () => [], importFacebookWatcher: async () => { importCalls++; return {}; },
} });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => { fallbackCalls++; return []; } } });
mock.module("@/features/facebook-groups/server", { namedExports: { isEnabledWatchedFacebookSource: async () => true } });
mock.module("@/features/facebook-worker/post-flow", { namedExports: {
  processFacebookPostBatch: async () => { observedAndroidDataOnly = androidDataOnlyImportActive(); return ({ warnings: [], postsProcessed: 0, listingsCreated: 0, listingsUpdated: 0, listingsSkipped: 0, errors: 0, persistenceDiagnostics: [], outcomes: [], reconciliationDiagnostics: [] }); },
  mergeReconciliationDiagnostics: () => [],
} });
const { authenticateSignedCollectorRequest } = await import("../signed-device-auth.ts");
const { processFacebookCollectorBatch } = await import("../facebook-batch-server.ts");
const TOKEN = "test-secret-token";
function signed(nonce = "nonce_auth_test_123456789") {
  const pathname = "/api/collector/android/jobs/claim"; const body = "{}";
  const auth = createCollectorAuthHeaders({ deviceId: DEVICE, deviceToken: TOKEN, method: "POST", pathname, body, nonce });
  const request = new Request(`https://example.invalid${pathname}`, { method: "POST", body, headers: {
    "x-flip-collector-device-id": auth.deviceId, "x-flip-collector-timestamp": auth.timestamp, "x-flip-collector-nonce": auth.nonce, "x-flip-collector-signature": auth.signature,
  } });
  return { request, pathname, body, markHealthy: true, expectedConsumerType: "ANDROID_WEBVIEW" as const };
}
function resetDevice(type = "ANDROID_WEBVIEW", revoked_at: string | null = null) {
  db = new FakeFacebookSupabase(); nonces.clear(); nonceFailure = false;
  db.seed("collector_devices", [{ id: DEVICE, device_name: "Mock Android", consumer_type: type, token_hash: collectorSigningKey(TOKEN), revoked_at }]);
}
test("real signed device auth enforces persisted consumer before writing heartbeat", async () => {
  resetDevice("BROWSER_EXTENSION");
  await assert.rejects(authenticateSignedCollectorRequest(signed()), /COLLECTOR_CONSUMER_MISMATCH/);
  assert.equal(db.rows("collector_devices")[0].last_heartbeat_at, undefined);
  resetDevice(); assert.equal((await authenticateSignedCollectorRequest(signed())).device.id, DEVICE);
  assert.ok(db.rows("collector_devices")[0].last_heartbeat_at);
  await assert.rejects(authenticateSignedCollectorRequest({ ...signed("nonce_auth_browser_123456"), expectedConsumerType: "BROWSER_EXTENSION" }), /COLLECTOR_CONSUMER_MISMATCH/);
});
test("real signed auth handles revocation, replay and nonce storage failure", async () => {
  resetDevice("ANDROID_WEBVIEW", new Date().toISOString()); await assert.rejects(authenticateSignedCollectorRequest(signed()), /INVALID_DEVICE/);
  resetDevice(); await authenticateSignedCollectorRequest(signed()); await assert.rejects(authenticateSignedCollectorRequest(signed()), /REPLAYED_NONCE/);
  resetDevice(); nonceFailure = true; await assert.rejects(authenticateSignedCollectorRequest(signed()), /NONCE_STORAGE_FAILED/);
});
function seedScans(withClaimed: boolean) {
  db = new FakeFacebookSupabase(); fallbackCalls = 0; importCalls = 0;
  const filter = { id: "filter-mock", sources: ["facebook"] };
  db.seed("collector_devices", [{ id: DEVICE }]);
  db.seed("source_scans", [
    { id: "wrong-first-scan", source: "facebook", scan_run_id: RUN, search_filter_id: "wrong-filter", status: "running", filter_snapshot: { id: "wrong-filter", sources: ["facebook"] }, warnings: [] },
    ...(withClaimed ? [{ id: SOURCE_SCAN, source: "facebook", scan_run_id: RUN, search_filter_id: filter.id, status: "running", filter_snapshot: filter, warnings: [] }] : []),
  ]);
}
test("real batch orchestration selects the claimed scan from multiple jobs in one run", async () => {
  seedScans(true); const batch = normalizeFacebookCollectorBatch(completionPayload().batch);
  const result = await processFacebookCollectorBatch(DEVICE, batch, { sourceScanId: SOURCE_SCAN });
  assert.equal(result.status, "completed", JSON.stringify(db.rows("collector_scan_batches"))); assert.equal(result.quality, undefined); assert.deepEqual(result.sourceScanIds, [SOURCE_SCAN]); assert.equal(fallbackCalls, 0);
  assert.equal(db.rows("source_scans").find(row => row.id === "wrong-first-scan")?.status, "running");
});
test("missing claimed source scan fails without fallback to active filters", async () => {
  seedScans(false); const batch = normalizeFacebookCollectorBatch(completionPayload().batch);
  const result = await processFacebookCollectorBatch(DEVICE, batch, { sourceScanId: SOURCE_SCAN });
  assert.equal(result.status, "failed"); assert.equal(fallbackCalls, 0); assert.equal(importCalls, 0);
  assert.equal(db.rows("source_scans")[0].status, "running");
});

test("Android heartbeat cannot make the extension readiness look healthy", async () => {
  const { readCollectorReadiness } = await import("../facebook-dispatch.ts");
  db = new FakeFacebookSupabase();
  db.seed("collector_devices", [
    { id: DEVICE, consumer_type: "ANDROID_WEBVIEW", revoked_at: null, last_heartbeat_at: new Date().toISOString(), health_status: "HEALTHY" },
    { id: "browser-device", consumer_type: "BROWSER_EXTENSION", revoked_at: null, last_heartbeat_at: new Date(0).toISOString(), health_status: "HEALTHY" },
  ]);
  const readiness = await readCollectorReadiness(); assert.equal(readiness.ready, false); assert.equal(readiness.deviceId, "browser-device");
});
test("device registration persists Android consumer explicitly and preserves browser default", async () => {
  const { registerCollectorDevice } = await import("../device-auth.ts");
  db = new FakeFacebookSupabase();
  await registerCollectorDevice({ deviceName: "Android", installationId: "mock-a", consumerType: "ANDROID_WEBVIEW" });
  await registerCollectorDevice({ deviceName: "Browser", installationId: "mock-b" });
  assert.deepEqual(db.rows("collector_devices").map(row => row.consumer_type), ["ANDROID_WEBVIEW", "BROWSER_EXTENSION"]);
  await assert.rejects(registerCollectorDevice({ deviceName: "Bad", installationId: "bad", consumerType: "LEGACY_WORKER" as never }));
  assert.equal(db.rows("collector_devices").length, 2);
});

test("quality reporting is opt-in and reuses the actual batch accounting", async () => {
  seedScans(true); const batch = normalizeFacebookCollectorBatch(completionPayload().batch);
  const result = await processFacebookCollectorBatch(DEVICE, batch, { sourceScanId: SOURCE_SCAN, qualityReport: true });
  assert.equal(result.status, "completed"); assert.equal(result.quality?.capturedPosts, 0); assert.equal(result.quality?.saleIntentPosts, 0);
  assert.equal(result.quality?.missingDataPosts, 0); assert.ok(result.accounting);
});
test("read report is disabled by default without creating a database client", async () => {
  const { readFacebookRunQualityReport } = await import("./quality-server.ts");
  const previous = process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED;
  try {
    delete process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED; const before = adminCreations;
    assert.deepEqual(await readFacebookRunQualityReport({ runId: RUN }), { enabled: false, report: null }); assert.equal(adminCreations, before);
  } finally { if (previous === undefined) delete process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED; else process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED = previous; }
});
test("enabled report reads only Facebook source jobs in the requested run and consumer", async () => {
  const { readFacebookRunQualityReport } = await import("./quality-server.ts");
  const previous = process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED;
  try {
    process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED = "true"; db = new FakeFacebookSupabase();
    const base = { scan_run_id: RUN, job_type: "SOURCE_SCAN", status: "completed", attempts: 1, group_snapshot: [{ sourceId: "mock-group" }], result_summary: { status: "completed", captured: 2, listingsCreated: 1, listingsUpdated: 0, errors: 0 } };
    db.seed("facebook_scan_jobs", [{ ...base, id: "android", consumer_type: "ANDROID_WEBVIEW" }, { ...base, id: "browser", consumer_type: "BROWSER_EXTENSION" }, { ...base, id: "other-run", consumer_type: "ANDROID_WEBVIEW", scan_run_id: "other" }]);
    const result = await readFacebookRunQualityReport({ runId: RUN }); assert.equal(result.report?.coverage.jobs, 1); assert.equal(result.report?.metrics.listingsAdded.value, null);
    assert.equal(result.report?.writeObservations.reportedCreated, 1);
    assert.deepEqual([...new Set(db.accessLog().map(access => access.name))], ["facebook_scan_jobs"]);
    db.failNext("facebook_scan_jobs", "select", "connection reset"); await assert.rejects(readFacebookRunQualityReport({ runId: RUN }), /READ_FAILED/);
  } finally { if (previous === undefined) delete process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED; else process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED = previous; }
});
test("checkpoint adapter binds device, run, source and exact source scan before recovery", async () => {
  const { androidJobStore } = await import("./server.ts");
  db = new FakeFacebookSupabase(); const binding = { deviceId: DEVICE, batchId: "33333333-3333-4333-8333-333333333333", runId: RUN, sourceScanId: SOURCE_SCAN, sourceId: "mock-group", sourceUrl: "https://www.facebook.com/groups/mock-group/" };
  const row = { device_id: DEVICE, scan_id: RUN, batch_id: binding.batchId, source_id: binding.sourceId, source_url: binding.sourceUrl, status: "completed", result: { status: "completed", batchId: binding.batchId, sourceScanIds: [SOURCE_SCAN] } };
  db.seed("collector_scan_batches", [row]); const store = androidJobStore();
  assert.ok(await store.loadCompletedBatch!(binding));
  assert.equal(await store.loadCompletedBatch!({ ...binding, sourceScanId: "different-scan" }), null);
  assert.equal(await store.loadCompletedBatch!({ ...binding, deviceId: "different-device" }), null);
  db.seed("collector_scan_batches", [{ ...row, status: "processing" }]); assert.equal(await store.loadCompletedBatch!(binding), null);
});

test("a PostgREST row cap cannot silently turn partial data into a complete report", async () => {
  const { readFacebookRunQualityReport } = await import("./quality-server.ts");
  const previous = process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED;
  try {
    process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED = "true";
    const query = {
      select: () => query, eq: () => query, in: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: "one-visible-row" }], count: 2, error: null }).then(resolve),
    };
    readClientOverride = { from: () => query } as unknown as FakeFacebookSupabase;
    await assert.rejects(readFacebookRunQualityReport({ runId: RUN }), /FACEBOOK_REPORT_TRUNCATED/);
  } finally {
    readClientOverride = null;
    if (previous === undefined) delete process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED; else process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED = previous;
  }
});

test("actual Android complete route runs shared batch processing under data-only policy", async () => {
  const { androidRoute } = await import("./server.ts");
  seedScans(true); nonces.clear(); nonceFailure = false; observedAndroidDataOnly = false;
  db.seed("collector_devices", [{ id: DEVICE, device_name: "Android", consumer_type: "ANDROID_WEBVIEW", token_hash: collectorSigningKey(TOKEN), revoked_at: null }]);
  db.seed("facebook_scan_jobs", [jobRow()]);
  db.setRpc("begin_android_facebook_completion", () => ({ data: { outcome: "reserved" }, error: null }));
  db.setRpc("finish_android_facebook_completion", params => ({ data: params.p_receipt, error: null }));
  const body = JSON.stringify(completionPayload()); const pathname = "/api/collector/android/jobs/complete";
  const auth = createCollectorAuthHeaders({ deviceId: DEVICE, deviceToken: TOKEN, method: "POST", pathname, body });
  const request = new Request(`https://example.invalid${pathname}`, { method: "POST", body, headers: {
    "content-type": "application/json", "x-flip-collector-device-id": auth.deviceId, "x-flip-collector-timestamp": auth.timestamp,
    "x-flip-collector-nonce": auth.nonce, "x-flip-collector-signature": auth.signature,
  } });
  const response = await androidRoute(request, "complete"); const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.status, "completed");
  assert.equal(observedAndroidDataOnly, true); assert.equal(androidDataOnlyImportActive(), false);
});
