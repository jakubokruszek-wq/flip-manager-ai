import assert from "node:assert/strict";
import test from "node:test";

import { runnerVersionStale, versionReport } from "../src/version-sync.ts";

test("a runner on another version than the calling Worker is stale; unknown ids never trigger a reset", () => {
  assert.equal(runnerVersionStale({ worker: "new", runner: "old" }), true);
  assert.equal(runnerVersionStale({ worker: "new", runner: "new" }), false);
  assert.equal(runnerVersionStale({ worker: null, runner: "old" }), false);
  assert.equal(runnerVersionStale({ worker: "new", runner: null }), false);
});

test("/status version block: matches is null without both ids, so the workflow cannot confirm the state", () => {
  assert.deepEqual(versionReport({ worker: "a", runner: "a" }, false), { worker: "a", runner: "a", matches: true, runnerReset: false });
  assert.deepEqual(versionReport({ worker: "b", runner: "a" }, true), { worker: "b", runner: "a", matches: false, runnerReset: true });
  assert.equal(versionReport({ worker: null, runner: "a" }, false).matches, null);
});
