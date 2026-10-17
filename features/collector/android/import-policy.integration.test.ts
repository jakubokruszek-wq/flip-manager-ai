import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAndroidDataOnlyImport, androidDataOnlyImportActive } from "./import-policy.ts";

let afterCalls = 0; let fallback = false;
mock.module(pathToFileURL(path.resolve(import.meta.dirname, "../../../node_modules/next/server.js")).href, { namedExports: { after: () => { afterCalls++; if (fallback) throw Error("outside request"); } } });
const { runAfterResponse } = await import("../../facebook-watcher/run-after-response.ts");
test("Android data-only import cannot schedule gallery or Vision background tasks", async () => {
  afterCalls = 0; fallback = false; let ran = 0;
  await runAndroidDataOnlyImport(async () => {
    assert.equal(androidDataOnlyImportActive(), true); await Promise.resolve();
    runAfterResponse(async () => { ran++; });
  });
  assert.equal(afterCalls, 0); assert.equal(ran, 0); assert.equal(androidDataOnlyImportActive(), false);
});
test("fallback outside Next request also remains blocked for Android", () => {
  afterCalls = 0; fallback = true; let ran = false;
  runAndroidDataOnlyImport(() => runAfterResponse(async () => { ran = true; }));
  assert.equal(afterCalls, 0); assert.equal(ran, false);
});
test("parallel browser/other consumers retain their normal background behavior", async () => {
  afterCalls = 0; fallback = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const android = runAndroidDataOnlyImport(async () => { await gate; runAfterResponse(async () => undefined); assert.equal(androidDataOnlyImportActive(), true); });
  assert.equal(androidDataOnlyImportActive(), false);
  runAfterResponse(async () => undefined); assert.equal(afterCalls, 1); release(); await android; assert.equal(afterCalls, 1);
});
test("Android policy is cleared after a thrown import, without changing later consumers", () => {
  assert.throws(() => runAndroidDataOnlyImport(() => { throw Error("import failed"); }));
  assert.equal(androidDataOnlyImportActive(), false); fallback = true;
  let ran = false; runAfterResponse(async () => { ran = true; }); assert.equal(ran, true);
});
