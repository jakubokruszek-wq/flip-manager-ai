import assert from "node:assert/strict";
import test from "node:test";
import { facebookPersistenceFailure } from "./facebook-persistence-contract.ts";

const base = { metadataId: "metadata-1", membershipExists: true, isCurrentMatch: false, matchReasons: [] };

test("persistence contract requires source metadata and canonical membership", () => {
  assert.equal(facebookPersistenceFailure("REVIEW", { ...base, metadataId: null }), "FACEBOOK_METADATA_PERSIST_FAILED");
  assert.equal(facebookPersistenceFailure("REVIEW", { ...base, membershipExists: false }), "FACEBOOK_FILTER_RECONCILE_FAILED");
  assert.equal(facebookPersistenceFailure("REVIEW", { ...base, matchReasons: ["unknown_topFloor"] }), null);
  assert.equal(facebookPersistenceFailure("MATCHED", { ...base, isCurrentMatch: true }), null);
  assert.equal(facebookPersistenceFailure("MATCHED", base), "FACEBOOK_FILTER_RECONCILE_FAILED");
  assert.equal(facebookPersistenceFailure("REJECTED", base), null);
});
