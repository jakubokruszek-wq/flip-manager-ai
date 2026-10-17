import assert from "node:assert/strict";
import test from "node:test";
import { facebookJobFilterSnapshot } from "./consumer-routing.ts";

test("Android snapshot preserves the filter but excludes browser cycle markers", () => {
  const filter = { id: "mock-filter", sources: ["facebook"], maxPrice: 300000, _facebookScheduler: { cycleId: "browser-cycle" } };
  const snapshot = facebookJobFilterSnapshot(filter, "ANDROID_WEBVIEW");
  assert.equal(snapshot.id, filter.id); assert.equal(snapshot.maxPrice, filter.maxPrice); assert.deepEqual(snapshot.sources, filter.sources);
  assert.equal(snapshot._facebookScheduler, undefined); assert.ok(filter._facebookScheduler);
});
test("browser enqueue preserves its existing filter snapshot and marker", () => {
  const filter = { id: "mock-filter", _facebookScheduler: { cycleId: "browser-cycle" } };
  assert.equal(facebookJobFilterSnapshot(filter, "BROWSER_EXTENSION"), filter);
});
