import assert from "node:assert/strict";
import test from "node:test";
import { resolveListingStatusPresentation } from "./listing-status-presentation.ts";

test("Finder=REJECTED and lifecycle=REJECTED communicate the same state and must be shown once", () => {
  const presentation = resolveListingStatusPresentation({ finderStatus: "REJECTED", lifecycleStatus: "REJECTED" });
  assert.deepEqual(presentation, { mode: "unified", label: "REJECTED" });
});

test("Finder=REVIEW and lifecycle=REVIEW communicate the same state and must be shown once", () => {
  const presentation = resolveListingStatusPresentation({ finderStatus: "REVIEW", lifecycleStatus: "REVIEW" });
  assert.deepEqual(presentation, { mode: "unified", label: "REVIEW" });
});

test("Finder=MATCHED and lifecycle=ACTIVE are the normal matched/active pairing and must be shown once, not as two labels", () => {
  const presentation = resolveListingStatusPresentation({ finderStatus: "MATCHED", lifecycleStatus: "ACTIVE" });
  assert.deepEqual(presentation, { mode: "unified", label: "MATCHED" });
});

test("Finder=HISTORICAL is itself derived from lifecycle ARCHIVED or STALE, so pairing with either is 'same', never 'distinct'", () => {
  assert.deepEqual(resolveListingStatusPresentation({ finderStatus: "HISTORICAL", lifecycleStatus: "ARCHIVED" }), { mode: "unified", label: "HISTORICAL" });
  assert.deepEqual(resolveListingStatusPresentation({ finderStatus: "HISTORICAL", lifecycleStatus: "STALE" }), { mode: "unified", label: "HISTORICAL" });
});

test("Finder=REVIEW and lifecycle=ARCHIVED materially differ and must show both, never hidden", () => {
  const presentation = resolveListingStatusPresentation({ finderStatus: "REVIEW", lifecycleStatus: "ARCHIVED" });
  assert.deepEqual(presentation, { mode: "distinct", finderLabel: "REVIEW", lifecycleLabel: "ARCHIVED" });
});

test("Finder=MATCHED and lifecycle=STALE materially differ and must show both, never hidden", () => {
  const presentation = resolveListingStatusPresentation({ finderStatus: "MATCHED", lifecycleStatus: "STALE" });
  assert.deepEqual(presentation, { mode: "distinct", finderLabel: "MATCHED", lifecycleLabel: "STALE" });
});

test("every non-equivalent Finder/lifecycle pair is reported as distinct, and no pair is silently interpreted beyond agree/disagree", () => {
  const finderStatuses = ["MATCHED", "REVIEW", "REJECTED", "HISTORICAL"] as const;
  const lifecycleStatuses = ["ACTIVE", "REVIEW", "STALE", "ARCHIVED", "REJECTED"] as const;
  const EQUIVALENT = new Set(["MATCHED:ACTIVE", "REVIEW:REVIEW", "REJECTED:REJECTED", "HISTORICAL:ARCHIVED", "HISTORICAL:STALE"]);
  for (const finderStatus of finderStatuses) {
    for (const lifecycleStatus of lifecycleStatuses) {
      const presentation = resolveListingStatusPresentation({ finderStatus, lifecycleStatus });
      const expectedUnified = EQUIVALENT.has(`${finderStatus}:${lifecycleStatus}`);
      assert.equal(presentation.mode, expectedUnified ? "unified" : "distinct", `${finderStatus}/${lifecycleStatus} expected ${expectedUnified ? "unified" : "distinct"}`);
    }
  }
});

test("an unknown lifecycle status is never guessed to agree with the Finder decision — it is shown as Finder-only, not unified", () => {
  assert.deepEqual(resolveListingStatusPresentation({ finderStatus: "MATCHED", lifecycleStatus: null }), { mode: "finder-only", label: "MATCHED" });
  assert.deepEqual(resolveListingStatusPresentation({ finderStatus: "REJECTED", lifecycleStatus: undefined }), { mode: "finder-only", label: "REJECTED" });
});
