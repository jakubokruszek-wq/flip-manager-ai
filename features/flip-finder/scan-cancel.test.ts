import assert from "node:assert/strict";
import test from "node:test";
import { cancellationPatch, isValidScanRunId } from "./scan-cancel.ts";

test("cancellation validates run IDs and clears active lease", () => {
  assert.equal(isValidScanRunId("3362e4d2-3d53-4cab-bd99-1309895eca1c"), true);
  assert.equal(isValidScanRunId("not-a-run"), false);
  assert.deepEqual(cancellationPatch("2026-08-29T12:00:00.000Z"), {
    status: "failed",
    error_code: "SCAN_CANCELLED",
    error_message: "Scan cancelled by user",
    leased_until: null,
    finished_at: "2026-08-29T12:00:00.000Z",
  });
});
