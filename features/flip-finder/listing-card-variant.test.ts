import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowGenericStatusBadge } from "./listing-card-variant.ts";

test("the watcher variant suppresses the generic StatusBadge", () => {
  assert.equal(shouldShowGenericStatusBadge("watcher"), false);
});

test("the standalone (default Finder) variant keeps showing the generic StatusBadge, exactly as before variant existed", () => {
  assert.equal(shouldShowGenericStatusBadge("standalone"), true);
  assert.equal(shouldShowGenericStatusBadge(undefined), true, "an omitted variant must behave exactly like every pre-existing Finder call site");
});
