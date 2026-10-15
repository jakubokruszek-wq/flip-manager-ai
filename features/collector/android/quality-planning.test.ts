import assert from "node:assert/strict";
import test from "node:test";
import { buildFacebookBatchQuality, buildFacebookRunQualityReport, type FacebookQualityJob } from "./quality.ts";
import { aggregateFacebookScanAccounting, type FacebookPostOutcome } from "../../facebook-worker/scan-accounting.ts";
import { normalizeFacebookCollectorBatch } from "../facebook-batch.ts";
import { planAndroidFacebookScans, type FacebookPlanningSource, type FacebookScanObservation } from "./planning.ts";
import { completionPayload, RUN } from "./fixtures.test-support.ts";
import { normalizeFacebookSourceUrl } from "../facebook-production.ts";

test("source identity accepts numeric profiles and people URLs, rejects unrelated paths and credentials", () => {
  for (const url of ["https://www.facebook.com/profile.php?id=123456", "https://m.facebook.com/people/Test/123456/", "https://facebook.com/123456/"]) {
    assert.deepEqual(normalizeFacebookSourceUrl(url, "PROFILE"), { url: "https://www.facebook.com/profile.php?id=123456", type: "PROFILE", sourceId: "123456" });
    assert.equal(normalizeFacebookSourceUrl(url, "GROUP"), null);
  }
  for (const url of ["https://facebook.com/watch?id=123456", "https://facebook.com/posts/123456", "https://user:pass@facebook.com/profile.php?id=123456", "https://facebook.com:444/profile.php?id=123456", "https://facebook.com/profile.php?id=123456&id=789012", "https://facebook.com.evil.test/profile.php?id=123456"]) assert.equal(normalizeFacebookSourceUrl(url), null);
});

test("confirmed registry shape: 15 stored, 13 active, 11 groups and 2 profiles; unavailable profile is deferred", () => {
  const sources = Array.from({ length: 11 }, (_, n) => source(`group-${n}`));
  sources.push(source("profile-ok", { url: "https://facebook.com/profile.php?id=123456" }), source("profile-unavailable", { url: "https://facebook.com/profile.php?id=789012", access_status: "UNAVAILABLE" }), source("disabled-a", { enabled: false }), source("disabled-b", { enabled: false }));
  const plan = planAndroidFacebookScans({ sources, history: [], preview: true, now: NOW });
  assert.equal(sources.filter(s => s.enabled).length, 13);
  assert.equal(plan.items.filter(s => s.type === "GROUP").length, 11);
  assert.equal(plan.items.filter(s => s.type === "PROFILE").length, 1);
  assert.deepEqual(plan.deferred.find(s => s.groupId === "profile-unavailable"), { groupId: "profile-unavailable", reason: "ACCESS_REQUIRES_ATTENTION" });
});

const outcomes: FacebookPostOutcome[] = [
  { postId: "1", primaryOutcome: "MATCHED", reasonCodes: [] },
  { postId: "2", primaryOutcome: "REVIEW", reasonCodes: ["unknown_price", "unknown_area", "unknown_price"] },
  { postId: "3", primaryOutcome: "NON_SALE", reasonCodes: ["buy_request"] },
];
function qualityFixture() {
  const raw = completionPayload().batch;
  raw.health.capturedPostCount = 3; raw.health.visibleCardCount = 3;
  raw.posts = ["Sprzedam mieszkanie 50 m2", "Sprzedam mieszkanie, cena do ustalenia", "Kupię mieszkanie"].map((text, i) => ({ postId: String(i + 1), permalink: `https://www.facebook.com/groups/mock-group/posts/${i + 1}/`, sourceId: "mock-group", sourceType: "GROUP", text, identityConfidence: "EXACT", publishedAt: new Date().toISOString(), author: "Mock", media: [] }));
  return buildFacebookBatchQuality(normalizeFacebookCollectorBatch(raw), outcomes, new Set(["3"]));
}
function job(id: string, summary: unknown, patch: Partial<FacebookQualityJob> = {}): FacebookQualityJob {
  return { id, scan_run_id: RUN, consumer_type: "ANDROID_WEBVIEW", job_type: "SOURCE_SCAN", status: "completed", attempts: 1, group_snapshot: [{ sourceId: id }], result_summary: summary, ...patch };
}
test("quality reuses sale-intent classifier and counts posts with missing fields once", () => {
  const quality = qualityFixture();
  assert.equal(quality.saleIntentPosts, 2); assert.equal(quality.missingDataPosts, 1); assert.equal(quality.confirmedIdentityPosts, 2); assert.equal(quality.rejectedPosts, 1);
  assert.deepEqual(quality.missingDataReasons, { unknown_price: 1, unknown_area: 1 });
});
test("report aggregates persisted results and does not count duplicate job rows twice", () => {
  const summary = { status: "completed", captured: 3, listingsCreated: 1, listingsUpdated: 1, errors: 0, quality: qualityFixture(), accounting: aggregateFacebookScanAccounting(outcomes, 3) };
  const first = job("group-a", { ok: true, result: summary });
  const report = buildFacebookRunQualityReport([first, first, job("group-b", null, { status: "failed", attempts: 3 })], { runId: RUN });
  assert.deepEqual(report.groups, { planned: 2, attempted: 2, scanned: 1, successful: 1, failed: 1 });
  assert.equal(report.metrics.postsCaptured.value, 3); assert.equal(report.metrics.postsCaptured.observedJobs, 1); assert.equal(report.metrics.postsWithMissingData.value, 1);
  assert.equal(report.failures.terminalScans, 1); assert.equal(report.failures.leaseRecoveries, 2); assert.equal(report.rejectionReasons.buy_request, 1);
  assert.deepEqual(report.coverage.warnings, ["DISTINCT_LISTING_WRITES_UNVERIFIED", "PARTIAL_HISTORICAL_COVERAGE"]);
});
test("historical absence, malformed counters and incomplete accounting remain unknown", () => {
  const report = buildFacebookRunQualityReport([job("old", { status: "completed", postsReceived: 4, listingsCreated: 1, listingsUpdated: -1, accounting: { rawCaptured: 4 } })], { runId: RUN });
  assert.equal(report.metrics.postsCaptured.value, 4); assert.equal(report.metrics.postsWithSaleIntent.value, null); assert.equal(report.metrics.postsWithMissingData.value, null);
  assert.equal(report.metrics.listingsUpdated.value, null); assert.equal(report.coverage.accountingJobs, 0);
});
test("concurrent phone and browser creation observations never masquerade as two physical additions", () => {
  const summary = { status: "completed", captured: 1, listingsCreated: 1, listingsUpdated: 0 };
  const phone = job("phone", summary);
  const browser = job("browser", summary, { consumer_type: "BROWSER_EXTENSION" });
  const report = buildFacebookRunQualityReport([phone, phone, browser], { runId: RUN, consumerTypes: ["ANDROID_WEBVIEW", "BROWSER_EXTENSION"] });
  assert.equal(report.metrics.listingsAdded.value, null);
  assert.equal(report.writeObservations.reportedCreated, 2);
  assert.equal(report.metrics.listingsUpdated.value, 0);
  assert.ok(report.coverage.warnings.includes("DISTINCT_LISTING_WRITES_UNVERIFIED"));
  // A single job can race with a writer outside the selected report/run too.
  assert.equal(buildFacebookRunQualityReport([phone], { runId: RUN }).metrics.listingsAdded.value, null);
});
test("report excludes other runs, other consumers and gallery jobs", () => {
  const rows = [job("android", null), job("browser", null, { consumer_type: "BROWSER_EXTENSION" }), job("gallery", null, { job_type: "GALLERY_HYDRATION" }), job("other-run", null, { scan_run_id: "other" })];
  assert.equal(buildFacebookRunQualityReport(rows, { runId: RUN }).coverage.jobs, 1);
  assert.equal(buildFacebookRunQualityReport(rows, { runId: RUN, consumerTypes: ["ANDROID_WEBVIEW", "BROWSER_EXTENSION"] }).coverage.jobs, 2);
  assert.throws(() => buildFacebookRunQualityReport(rows, { runId: RUN, consumerTypes: ["OLX"] }), /CONSUMER_INVALID/);
});
test("reason counters cannot inject prototype keys or raw diagnostic text", () => {
  const accounting = aggregateFacebookScanAccounting(outcomes, 3);
  accounting.reasonCounts = JSON.parse('{"__proto__":4,"constructor":9,"cookie=secret":1,"toString":1,"buy_request":1}');
  const report = buildFacebookRunQualityReport([job("safe", { status: "completed", accounting })], { runId: RUN });
  assert.deepEqual(report.rejectionReasons, { buy_request: 1 });
});
const NOW = Date.parse("2026-10-15T06:00:00Z");
function source(id: string, patch: Partial<FacebookPlanningSource> = {}): FacebookPlanningSource { return { id, name: id, url: `https://www.facebook.com/groups/${id}/`, priority: "normal", enabled: true, last_checked_at: "2026-10-15T05:00:00Z", access_status: "CONNECTED", ...patch }; }
function history(sourceId: string, created: number, durationMs: number): FacebookScanObservation { return { sourceId, finishedAt: "2026-10-15T05:00:00Z", status: "completed", durationMs, listingsCreated: created, listingsUpdated: 0 }; }
test("new planner is disabled by default and cannot mutate inputs or enqueue", () => {
  const sources = [source("a")]; const before = structuredClone(sources);
  assert.equal(planAndroidFacebookScans({ sources, history: [], now: NOW }).mode, "DISABLED");
  assert.deepEqual(planAndroidFacebookScans({ sources, history: [], now: NOW }).items, []); assert.deepEqual(sources, before);
});
test("priority dominates yield and time; higher yield per minute wins within priority", () => {
  const plan = planAndroidFacebookScans({ preview: true, now: NOW, sources: [source("high", { priority: "high" }), source("slow"), source("fast")], history: [history("slow", 1, 180_000), history("fast", 4, 30_000)] });
  assert.deepEqual(plan.items.map(i => i.sourceId), ["high", "fast", "slow"]); assert.equal(plan.source, "facebook"); assert.equal(plan.consumerType, "ANDROID_WEBVIEW");
});
test("overdue and never-observed groups get exploration ahead of recent profitable groups", () => {
  const plan = planAndroidFacebookScans({ preview: true, now: NOW, sources: [source("recent"), source("old", { last_checked_at: "2026-10-12T00:00:00Z" }), source("new", { last_checked_at: null })], history: [history("recent", 20, 10_000)] });
  assert.deepEqual(plan.items.map(i => i.sourceId), ["new", "old", "recent"]);
});
test("planner rejects disabled, blocked, duplicate and non-Facebook sources", () => {
  const plan = planAndroidFacebookScans({ preview: true, now: NOW, sources: [source("safe"), source("same", { url: "https://www.facebook.com/groups/safe/" }), source("blocked", { access_status: "AUTH_REQUIRED" }), source("olx", { url: "https://www.olx.pl/" }), source("disabled", { enabled: false })], history: [] });
  assert.equal(plan.items.length, 1); assert.equal(plan.deferred.length, 4);
});
test("preview of thirteen mock sources is stable without inventing historical effectiveness", () => {
  const sources = Array.from({ length: 13 }, (_, n) => source(`mock-${n.toString().padStart(2, "0")}`, { last_checked_at: null }));
  const a = planAndroidFacebookScans({ preview: true, now: NOW, sources, history: [] });
  const b = planAndroidFacebookScans({ preview: true, now: NOW, sources: [...sources].reverse(), history: [] });
  assert.deepEqual(a.items, b.items); assert.equal(a.items.length, 13); assert.ok(a.items.every(i => i.observedScans === 0 && i.medianDurationMs === null));
});
