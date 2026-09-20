import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFacebookScanAccounting, classifyFacebookDecision } from "../../facebook-worker/scan-accounting.ts";
import { projectPersistedFacebookAccounting } from "./scan-accounting-projection.ts";

const accounting = aggregateFacebookScanAccounting([classifyFacebookDecision({ bucket: "MATCHED", reasons: [], unknownFields: [] })], 1);

test("scan progress consumes persisted accounting as authoritative", () => {
  const projection = projectPersistedFacebookAccounting([{ accounting }, { accounting }]);
  assert.equal(projection.accountingMode, "AUTHORITATIVE");
  assert.equal(projection.accounting?.uniqueCaptured, 2);
  assert.equal(projection.accounting?.byOutcome.MATCHED, 2);
});

test("historical batches without accounting stay on an explicit legacy path", () => {
  const projection = projectPersistedFacebookAccounting([{ captured: 1 }, { status: "completed" }]);
  assert.equal(projection.accounting, null);
  assert.equal(projection.accountingMode, "LEGACY");
  assert.equal(projection.accountingError, null);
});

test("an accounting invariant error never falls back to fabricated authoritative totals", () => {
  const projection = projectPersistedFacebookAccounting([{ accountingError: "FACEBOOK_ACCOUNTING_INVARIANT_FAILED" }]);
  assert.equal(projection.accounting, null);
  assert.equal(projection.accountingMode, "LEGACY");
  assert.equal(projection.accountingError, "FACEBOOK_ACCOUNTING_INVARIANT_FAILED");
});
