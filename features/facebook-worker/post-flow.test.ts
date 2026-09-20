import assert from "node:assert/strict";
import test from "node:test";
import { processFacebookPostBatch, redactFacebookPostPreview, type FacebookPostImportResult } from "./post-flow.ts";
import { staleFacebookPostResult } from "./vision-adapter.ts";
import type { FacebookPostSnapshot } from "./types.ts";
import { aggregateFacebookScanAccounting, verifyFacebookScanAccountingInvariant } from "./scan-accounting.ts";

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

test("post flow records persistence timing telemetry", async () => {
  const result = await processFacebookPostBatch([post("timed")], async () => outcome());
  assert.equal(result.postTimings.length, 1);
  assert.equal(result.postTimings[0].postId, "timed");
  assert.equal(result.postTimings[0].cacheHit, false);
  assert.ok(result.postTimings[0].persistenceMs >= 0);
  assert.equal(result.postTimings[0].totalMs, result.postTimings[0].persistenceMs);
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

test("old-post skip is counted only for the deterministic stale reason", async () => {
  const old = { ...post("old"), publishedAt: new Date(Date.now() - 73 * 60 * 60_000).toISOString() };
  const result = await processFacebookPostBatch([old], async (item) => staleFacebookPostResult(item));
  assert.equal(result.oldPostsSkippedHeavyProcessing, 1);
  const unknown = await processFacebookPostBatch([{ ...post("unknown"), publishedAt: null }], async () => outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0 }));
  assert.equal(unknown.oldPostsSkippedHeavyProcessing, 0);
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

// The pipeline's own throw sites name themselves as "CODE: detail" (e.g.
// "FACEBOOK_METADATA_PERSIST_FAILED: duplicate key..."). A failure warning
// must keep that specific name instead of collapsing every detailed error
// into the same generic FACEBOOK_POST_EXTRACTION_FAILED bucket — otherwise
// the accounting/diagnostics built on top of these warnings cannot tell two
// genuinely different failures apart.
test("a failure warning keeps the thrown error's own named code, not the generic fallback, whenever one exists", async () => {
  const result = await processFacebookPostBatch([post("meta-fail")], async () => {
    throw new Error("FACEBOOK_METADATA_PERSIST_FAILED: duplicate key value violates unique constraint");
  });
  assert.equal(result.extractionFailed, 1);
  assert.match(result.warnings[0], /FACEBOOK_METADATA_PERSIST_FAILED/, "the specific code must survive, not be discarded for the generic fallback");
  assert.doesNotMatch(result.warnings[0], /^Post nie został przetworzony: FACEBOOK_POST_EXTRACTION_FAILED\.$/);
});

test("a failure with no identifiable code still falls back to the generic extraction-failed code", async () => {
  const result = await processFacebookPostBatch([post("generic-fail")], async () => {
    throw new Error("Cannot read properties of null (reading 'foo')");
  });
  assert.match(result.warnings[0], /FACEBOOK_POST_EXTRACTION_FAILED/);
});

// FACEBOOK_FILTER_RECONCILE_FAILED reconciliation diagnostics: the accounting
// code/outcome/warning text must stay exactly as before (safeErrorCode is
// untouched); the new reconciliationDiagnostics array is purely additive.
function reconcileFailure(cause: Record<string, unknown>): Error {
  return new Error("FACEBOOK_FILTER_RECONCILE_FAILED: CANONICAL_RECONCILIATION_FAILED: duplicate key value violates unique constraint", { cause });
}

test("a reconciliation failure with a Postgres error cause preserves postId/listingId/filterId and the raw DB fields, without changing accounting", async () => {
  const cause = { listingId: "listing-42", filterId: "filter-7", errorCode: "23505", errorMessage: "duplicate key value violates unique constraint \"listing_filter_matches_pkey\"", errorDetails: "Key (listing_id, search_filter_id)=(listing-42, filter-7) already exists.", errorHint: null };
  const result = await processFacebookPostBatch([post("reconcile-fail")], async () => { throw reconcileFailure(cause); });

  assert.equal(result.extractionFailed, 1);
  assert.equal(result.outcomes[0].primaryOutcome, "EXTRACTION_FAILED");
  assert.deepEqual(result.outcomes[0].reasonCodes, ["FACEBOOK_FILTER_RECONCILE_FAILED"], "accounting reason must stay the stable public code, never the raw DB text");
  assert.equal(result.warnings[0], "Post nie został przetworzony: FACEBOOK_FILTER_RECONCILE_FAILED.");

  assert.equal(result.reconciliationDiagnostics.length, 1);
  assert.deepEqual(result.reconciliationDiagnostics[0], {
    stage: "canonical_reconciliation",
    postId: "reconcile-fail",
    listingId: "listing-42",
    filterId: "filter-7",
    errorCode: "23505",
    errorMessage: "duplicate key value violates unique constraint \"listing_filter_matches_pkey\"",
    errorDetails: "Key (listing_id, search_filter_id)=(listing-42, filter-7) already exists.",
    errorHint: null,
  });
});

test("a PostgREST-style error code (result-shape failure) is preserved through the same path", async () => {
  const cause = { listingId: "listing-1", filterId: "filter-1", errorCode: "PGRST116", errorMessage: "JSON object requested, multiple (or no) rows returned", errorDetails: "Results contain 0 rows", errorHint: null };
  const result = await processFacebookPostBatch([post("pgrst-fail")], async () => { throw reconcileFailure(cause); });
  assert.equal(result.reconciliationDiagnostics[0].errorCode, "PGRST116");
  assert.equal(result.reconciliationDiagnostics[0].errorDetails, "Results contain 0 rows");
});

test("tokens/cookies/emails/phones embedded in the DB message or details are redacted before persistence", async () => {
  const cause = {
    listingId: "listing-1", filterId: "filter-1", errorCode: "42501",
    errorMessage: "permission denied; authorization:sk_live_should_not_survive for user jan.kowalski@example.com",
    errorDetails: "cookie=must-not-survive; phone +48 500 100 200 in payload",
    errorHint: "session: abc123",
  };
  const result = await processFacebookPostBatch([post("secret-fail")], async () => { throw reconcileFailure(cause); });
  const diagnostic = result.reconciliationDiagnostics[0];
  assert.doesNotMatch(diagnostic.errorMessage ?? "", /sk_live_should_not_survive/);
  assert.match(diagnostic.errorMessage ?? "", /authorization=\[REDACTED\]/);
  assert.doesNotMatch(diagnostic.errorMessage ?? "", /jan\.kowalski@example\.com/);
  assert.doesNotMatch(diagnostic.errorDetails ?? "", /must-not-survive/);
  assert.doesNotMatch(diagnostic.errorDetails ?? "", /500[\s.-]?100[\s.-]?200/);
  assert.doesNotMatch(diagnostic.errorHint ?? "", /abc123/);
  assert.match(diagnostic.errorHint ?? "", /session=\[REDACTED\]/);
});

test("every diagnostic string field is length-bounded even when the DB message/details is huge", async () => {
  const cause = { listingId: "listing-1", filterId: "filter-1", errorCode: "XX000", errorMessage: "x".repeat(5000), errorDetails: "y".repeat(5000), errorHint: "z".repeat(5000) };
  const result = await processFacebookPostBatch([post("huge-fail")], async () => { throw reconcileFailure(cause); });
  const diagnostic = result.reconciliationDiagnostics[0];
  assert.ok((diagnostic.errorMessage?.length ?? 0) <= 300);
  assert.ok((diagnostic.errorDetails?.length ?? 0) <= 300);
  assert.ok((diagnostic.errorHint?.length ?? 0) <= 300);
});

test("no stack trace is ever included in the persisted diagnostic", async () => {
  const cause = { listingId: "listing-1", filterId: "filter-1", errorCode: "23505", errorMessage: "boom", errorDetails: null, errorHint: null };
  const result = await processFacebookPostBatch([post("stack-fail")], async () => { throw reconcileFailure(cause); });
  const diagnostic = result.reconciliationDiagnostics[0];
  assert.ok(!("stack" in diagnostic));
  assert.deepEqual(Object.keys(diagnostic).sort(), ["errorCode", "errorDetails", "errorHint", "errorMessage", "filterId", "listingId", "postId", "stage"]);
});

test("an unrelated error (different code, or a reconciliation-failure message with no cause attached) leaves reconciliationDiagnostics empty and behaves exactly as before", async () => {
  const withoutCause = await processFacebookPostBatch([post("no-cause")], async () => {
    throw new Error("FACEBOOK_FILTER_RECONCILE_FAILED: CANONICAL_RECONCILIATION_FAILED: some detail");
  });
  assert.deepEqual(withoutCause.reconciliationDiagnostics, []);
  assert.equal(withoutCause.outcomes[0].reasonCodes[0], "FACEBOOK_FILTER_RECONCILE_FAILED");

  const differentFailure = await processFacebookPostBatch([post("meta-fail-2")], async () => {
    throw new Error("FACEBOOK_METADATA_PERSIST_FAILED: duplicate key value violates unique constraint", { cause: { listingId: "listing-1", filterId: "filter-1", errorCode: "23505", errorMessage: "unrelated", errorDetails: null, errorHint: null } });
  });
  assert.deepEqual(differentFailure.reconciliationDiagnostics, [], "diagnostics are scoped to FACEBOOK_FILTER_RECONCILE_FAILED only, even if another failure also carries a cause");
});

test("the reconciliation diagnostics array stays bounded even if every post in a batch fails", async () => {
  const posts = Array.from({ length: 60 }, (_, index) => post(`bulk-${index}`));
  const result = await processFacebookPostBatch(posts, async () => {
    throw reconcileFailure({ listingId: "listing-x", filterId: "filter-x", errorCode: "40001", errorMessage: "serialization failure", errorDetails: null, errorHint: null });
  });
  assert.equal(result.extractionFailed, 60);
  assert.ok(result.reconciliationDiagnostics.length <= 50, `expected a bounded diagnostics array, got ${result.reconciliationDiagnostics.length}`);
});

test("image failure warning does not prevent listing persistence", async () => {
  const result = await processFacebookPostBatch([post("3")], async () => outcome({ imagesMirrored: 0, warnings: ["image fetch failed"] }));
  assert.equal(result.listingsCreated, 1);
  assert.equal(result.imagesMirrored, 0);
  assert.deepEqual(result.warnings, ["image fetch failed"]);
});

test("exposes persistence counters without double counting cache reuse", async () => {
  const diagnostic = { postId: "obs", creationTime: "2026-08-23T10:00:00.000Z", timestampSource: "POST_PAGE_METADATA" as const, publishedAtCandidate: "2026-08-23T10:00:00.000Z", publishedAtPersistAttempted: true, publishedAtPersisted: true, exactBoundCandidates: 5, relevanceAccepted: 1, relevanceRejected: 4, mirrorAttempted: 5, mirroredCount: 1, persistedNewImageCount: 1, finalListingImageCount: 1, persistedImageCount: 1, imageReasonCode: "NONE", reasonCodes: [], imageProvenance: [] };
  const first = await processFacebookPostBatch([post("obs")], async () => outcome({ persistenceDiagnostics: diagnostic }));
  const reused = await processFacebookPostBatch([{ ...post("obs"), cacheHit: { sourceJobId: "job-1", listingId: "listing-1", analyzedAt: "2026-08-23T10:00:00.000Z", scope: "RUN", outcome: "SELL_PERSISTED" } }], async () => outcome({ status: "reused", listingCreated: false, matched: true, matchCreated: false, imagesMirrored: 0 }));
  assert.deepEqual(first.persistenceDiagnostics[0], diagnostic);
  assert.equal(reused.persistenceDiagnostics.length, 1);
  assert.deepEqual(reused.persistenceDiagnostics[0], {
    postId: "obs", creationTime: "2026-08-16T10:00:00.000Z", timestampSource: "POST_PAGE",
    publishedAtCandidate: "2026-08-16T10:00:00.000Z", publishedAtPersistAttempted: false, publishedAtPersisted: false,
    exactBoundCandidates: 0, relevanceAccepted: 0, relevanceRejected: 0, mirrorAttempted: 0, mirroredCount: 0, persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0,
    imageReasonCode: "NONE", reasonCodes: [], imageProvenance: [],
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
      imageProvenance: [],
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
    imageReasonCode: "NONE", reasonCodes: [], imageProvenance: [],
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

// Scan accounting: every post this call actually attempts must end up with
// exactly one classified outcome, whether it was skipped, persisted with a
// canonical decision, or threw — and the invariant (sum of buckets ==
// unique captured) must hold for the resulting funnel.
test("every attempted post receives exactly one accounting outcome, and the funnel invariant holds for a realistic mixed batch", async () => {
  const items = [
    post("rental", "Do wynajęcia mieszkanie 2 pokoje"),
    post("matched"),
    post("review"),
    post("rejected"),
    post("throws"),
  ];
  const result = await processFacebookPostBatch(items, async (item) => {
    if (item.postId === "rental") return outcome({ status: "skipped", listingId: null, listingCreated: false, matched: false, matchCreated: false, imagesMirrored: 0, notProperty: { realEstateLanguage: true, structuredFieldCount: 1, detectedFields: [], classification: "non_sale_intent", reasonCode: "FACEBOOK_RENT_REQUEST" } });
    if (item.postId === "matched") return outcome({ persistenceDiagnostics: { ...emptyDiagnostics("matched"), decision: "MATCHED", decisionReasons: [] } });
    if (item.postId === "review") return outcome({ persistenceDiagnostics: { ...emptyDiagnostics("review"), decision: "REVIEW", decisionReasons: [], decisionUnknownFields: ["topFloor", "buildingType"] } });
    if (item.postId === "rejected") return outcome({ matched: false, matchCreated: false, persistenceDiagnostics: { ...emptyDiagnostics("rejected"), decision: "REJECTED", decisionReasons: ["max_price_per_sqm"] } });
    throw new Error("FACEBOOK_METADATA_PERSIST_FAILED: boom");
  });
  assert.equal(result.outcomes.length, items.length, "every attempted post must produce exactly one outcome");
  assert.deepEqual(result.outcomes.map((item) => item.primaryOutcome), ["RENTAL", "MATCHED", "REVIEW", "HARD_FILTER_REJECT", "EXTRACTION_FAILED"]);
  assert.deepEqual(result.outcomes.find((item) => item.postId === "review")?.reasonCodes.sort(), ["unknown_buildingType", "unknown_topFloor"]);
  assert.deepEqual(result.outcomes.find((item) => item.postId === "rejected")?.reasonCodes, ["max_price_per_sqm"]);

  const accounting = aggregateFacebookScanAccounting(result.outcomes, items.length);
  assert.equal(verifyFacebookScanAccountingInvariant(accounting), true);
  assert.equal(accounting.uniqueCaptured, items.length);
  assert.equal(accounting.byOutcome.EXTRACTION_FAILED, 1);
  assert.equal(accounting.byOutcome.RENTAL, 1);
});

test("a post skipped for lacking a stable id/permalink still receives an accounting outcome, never silently disappearing", async () => {
  const result = await processFacebookPostBatch([{ ...post("no-id"), postId: null, permalink: null }], async () => outcome());
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].primaryOutcome, "IDENTITY_UNVERIFIED");
});

test("a permalink-only captured post keeps a stable accounting identity for batch deduplication", async () => {
  const result = await processFacebookPostBatch([{ ...post("permalink-only"), postId: null }], async () => outcome({ persistenceDiagnostics: { ...emptyDiagnostics("permalink-only"), decision: "MATCHED", decisionReasons: [] } }));
  assert.equal(result.outcomes[0].postId, "https://www.facebook.com/groups/group-1/posts/permalink-only/");
});

function emptyDiagnostics(postId: string) {
  return { postId, creationTime: null, timestampSource: "UNKNOWN" as const, publishedAtCandidate: null, publishedAtPersistAttempted: false, publishedAtPersisted: false, exactBoundCandidates: 0, relevanceAccepted: 0, relevanceRejected: 0, mirrorAttempted: 0, mirroredCount: 0, persistedNewImageCount: 0, finalListingImageCount: 0, persistedImageCount: 0, imageReasonCode: "NONE", reasonCodes: [], imageProvenance: [] };
}
