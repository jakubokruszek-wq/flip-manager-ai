import assert from "node:assert/strict";
import test from "node:test";
import { isFacebookOrphan, orphanDiagnostic } from "./facebook-orphan-recovery.ts";

test("orphan detector requires trusted Facebook identity and flags missing canonical projection", () => {
  assert.equal(isFacebookOrphan({ hasTrustedIdentity: true, hasSourceMetadata: false, missingFilterIds: [] }), true);
  assert.equal(isFacebookOrphan({ hasTrustedIdentity: true, hasSourceMetadata: true, missingFilterIds: ["filter-1"] }), true);
  assert.equal(isFacebookOrphan({ hasTrustedIdentity: true, hasSourceMetadata: true, missingFilterIds: [] }), false);
  assert.equal(isFacebookOrphan({ hasTrustedIdentity: false, hasSourceMetadata: false, missingFilterIds: ["filter-1"] }), false);
});

test("orphan diagnostic exposes whether immutable collector evidence can drive repair", () => {
  const diagnostic = orphanDiagnostic({ listingId: "listing-1", externalListingId: "post-1", originalUrl: "https://www.facebook.com/groups/g/posts/post-1", hasTrustedIdentity: true, hasSourceMetadata: false, missingFilterIds: ["filter-1"], capturedEvidenceAvailable: true });
  assert.equal(diagnostic.recoverableFromCapturedEvidence, true);
  assert.deepEqual(diagnostic.missingFilterIds, ["filter-1"]);
});
