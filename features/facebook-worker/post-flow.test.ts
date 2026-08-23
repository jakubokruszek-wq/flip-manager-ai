import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, redactFacebookPostPreview, type FacebookPostImportResult } from "./post-flow.ts";
import type { FacebookPostSnapshot } from "./types.ts";

function post(postId: string, text = "Sprzedam mieszkanie 45 m2, 2 pokoje, 350000 zl"): FacebookPostSnapshot {
  return { postId, groupId: "group-1", permalink: `https://www.facebook.com/groups/group-1/posts/${postId}/`, text, imageUrls: [], publishedAt: "2026-08-16T10:00:00.000Z" };
}

function outcome(patch: Partial<FacebookPostImportResult> = {}): FacebookPostImportResult {
  return { status: "created", listingId: "listing-1", listingCreated: true, listingUpdated: false, matched: true, matchCreated: true, imagesMirrored: 1, priceDrops: 0, warnings: [], ...patch };
}

test("post with successful extraction creates a listing and match", async () => {
  const result = await processFacebookPostBatch([post("1")], async () => outcome());
  assert.deepEqual({ created: result.listingsCreated, matched: result.matched, errors: result.errors }, { created: 1, matched: 1, errors: 0 });
});

test("the same post id seen in two groups keeps one listing identity", async () => {
  const seen = new Set<string>();
  const result = await processFacebookPostBatch([post("1"), { ...post("1"), groupId: "group-2", permalink: "https://www.facebook.com/groups/group-2/posts/1/" }], async (item) => {
    const existing = seen.has(item.postId!); seen.add(item.postId!);
    return outcome({ status: existing ? "updated" : "created", listingId: "listing-1", listingCreated: !existing, listingUpdated: false, matchCreated: !existing });
  });
  assert.equal(result.listingsCreated, 1);
  assert.deepEqual(result.listingIds, ["listing-1"]);
});

test("not-a-property post is skipped", async () => {
  const result = await processFacebookPostBatch([post("2", "Spotkanie grupy w sobote")], async () => outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0 }));
  assert.equal(result.listingsSkipped, 1);
  assert.equal(result.listingsCreated, 0);
});

test("one extraction failure does not stop the batch", async () => {
  const result = await processFacebookPostBatch([post("bad"), post("good")], async (item) => {
    if (item.postId === "bad") throw new Error("FACEBOOK_POST_EXTRACTION_FAILED");
    return outcome();
  });
  assert.equal(result.extractionFailed, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.listingsCreated, 1);
});

test("image failure warning does not prevent listing persistence", async () => {
  const result = await processFacebookPostBatch([post("3")], async () => outcome({ imagesMirrored: 0, warnings: ["image fetch failed"] }));
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.imagesMirrored, 0);
  assert.deepEqual(result.warnings, ["image fetch failed"]);
});

test("exposes persistence counters without double counting cache reuse", async () => {
  const diagnostic = { postId: "obs", creationTime: "2026-08-23T10:00:00.000Z", timestampSource: "POST_PAGE_METADATA" as const, publishedAtCandidate: "2026-08-23T10:00:00.000Z", publishedAtPersistAttempted: true, publishedAtPersisted: true, exactBoundCandidates: 5, relevanceAccepted: 1, relevanceRejected: 4, mirrorAttempted: 5, mirroredCount: 1, persistedNewImageCount: 1, finalListingImageCount: 1, persistedImageCount: 1, imageReasonCode: "NONE", reasonCodes: [] };
  const first = await processFacebookPostBatch([post("obs")], async () => outcome({ persistenceDiagnostics: diagnostic }));
  const reused = await processFacebookPostBatch([{ ...post("obs"), cacheHit: { sourceJobId: "job-1", listingId: "listing-1", analyzedAt: "2026-08-23T10:00:00.000Z", scope: "RUN", outcome: "SELL_PERSISTED" } }], async () => outcome({ status: "reused", listingCreated: false, matched: true, matchCreated: false, imagesMirrored: 0 }));
  assert.deepEqual(first.persistenceDiagnostics[0], diagnostic);
  assert.equal(reused.persistenceDiagnostics.length, 1);
  assert.deepEqual(reused.persistenceDiagnostics[0], {
    postId: "obs", creationTime: "2026-08-16T10:00:00.000Z", timestampSource: "POST_PAGE",
    publishedAtCandidate: "2026-08-16T10:00:00.000Z", publishedAtPersistAttempted: false, publishedAtPersisted: false,
    exactBoundCandidates: 0, relevanceAccepted: 0, relevanceRejected: 0, mirrorAttempted: 0, mirroredCount: 0, persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0,
    imageReasonCode: "NONE", reasonCodes: [],
  });
});

test("keeps safe reason codes for persistence failures and count mismatches", async () => {
  const result = await processFacebookPostBatch([post("mismatch")], async () => outcome({
    persistenceDiagnostics: {
      postId: "mismatch", creationTime: null, timestampSource: "UNKNOWN", publishedAtCandidate: null,
      publishedAtPersistAttempted: true, publishedAtPersisted: false, exactBoundCandidates: 5,
      relevanceAccepted: 1, relevanceRejected: 4, mirrorAttempted: 5, mirroredCount: 1, persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0,
      imageReasonCode: "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH",
      reasonCodes: ["FACEBOOK_PUBLISHED_AT_PERSIST_FAILED", "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH"],
    },
  }));
  assert.equal(result.persistenceDiagnostics[0].publishedAtPersisted, false);
  assert.deepEqual(result.persistenceDiagnostics[0].reasonCodes, ["FACEBOOK_PUBLISHED_AT_PERSIST_FAILED", "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH"]);
  assert.equal(result.persistenceDiagnostics[0].imageReasonCode, "FACEBOOK_IMAGE_PERSIST_COUNT_MISMATCH");
});

test("always serializes zero observability counters", async () => {
  const result = await processFacebookPostBatch([post("zero")], async () => outcome());
  assert.deepEqual(result.persistenceDiagnostics[0], {
    postId: "zero", creationTime: "2026-08-16T10:00:00.000Z", timestampSource: "POST_PAGE",
    publishedAtCandidate: "2026-08-16T10:00:00.000Z", publishedAtPersistAttempted: false, publishedAtPersisted: false,
    exactBoundCandidates: 0, relevanceAccepted: 0, relevanceRejected: 0, mirrorAttempted: 0, mirroredCount: 0, persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0,
    imageReasonCode: "NONE", reasonCodes: [],
  });
});

test("matching listing is counted", async () => {
  const result = await processFacebookPostBatch([post("4")], async () => outcome({ matched: true }));
  assert.equal(result.matched, 1);
});

test("non-matching listing is persisted without a match", async () => {
  const result = await processFacebookPostBatch([post("5")], async () => outcome({ matched: false, matchCreated: false }));
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.matched, 0);
});

test("existing listing is updated without creating a duplicate", async () => {
  const result = await processFacebookPostBatch([post("6")], async () => outcome({ status: "updated", listingId: "existing", listingCreated: false, listingUpdated: true, matchCreated: false, priceDrops: 1 }));
  assert.equal(result.listingsCreated, 0);
  assert.equal(result.listingsUpdated, 1);
  assert.equal(result.priceDrops, 1);
  assert.deepEqual(result.listingIds, ["existing"]);
});

test("post without stable id and permalink is skipped before extraction", async () => {
  let called = false;
  const value = { ...post("7"), postId: null, permalink: null };
  const result = await processFacebookPostBatch([value], async () => { called = true; return outcome(); });
  assert.equal(called, false);
  assert.equal(result.listingsSkipped, 1);
});

test("skipped post stores bounded and redacted diagnostic instead of full text", async () => {
  const privateText = `Autor: Jan Kowalski\nKontakt +48 501 234 567 lub jan.kowalski@example.com. ${"Nieistotna dalsza treść ".repeat(30)}`;
  const item = { ...post("diagnostic", privateText), imageUrls: ["https://scontent.xx.fbcdn.net/a.jpg"] };
  const result = await processFacebookPostBatch([item], async () => outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0, notProperty: { realEstateLanguage: false, structuredFieldCount: 2, detectedFields: ["price", "area"] } }), { jobId: "job-1", sourceScanId: "scan-1" });
  const diagnostic = result.skippedDiagnostics[0];
  assert.equal(diagnostic.job_id, "job-1");
  assert.equal(diagnostic.source_scan_id, "scan-1");
  assert.equal(diagnostic.classification, "not_a_property");
  assert.deepEqual(diagnostic.detected_fields, ["price", "area"]);
  assert.ok(diagnostic.text_preview.length <= 300);
  assert.doesNotMatch(diagnostic.text_preview, /Jan Kowalski|501 234 567|jan\.kowalski@example\.com/);
  assert.match(diagnostic.text_preview, /AUTOR USUNIETY|TELEFON USUNIETY|EMAIL USUNIETY/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("stores diagnostics for at most three skipped posts", async () => {
  const items = ["1", "2", "3", "4"].map((id) => post(id, `Post ${id}`));
  const result = await processFacebookPostBatch(items, async () => outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0, notProperty: { realEstateLanguage: false, structuredFieldCount: 0, detectedFields: [] } }), { jobId: "job-1", sourceScanId: "scan-1" });
  assert.equal(result.skippedDiagnostics.length, 3);
});

test("redacts token-like values from preview", () => {
  assert.equal(redactFacebookPostPreview("token=secret-value mieszkanie"), "token=[REDACTED] mieszkanie");
});
