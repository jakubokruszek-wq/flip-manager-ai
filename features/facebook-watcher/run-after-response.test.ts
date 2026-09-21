import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Task 5: shouldAutoEnrichFacebookImages() queues gallery hydration via a
// bare `void promise.catch()`, which a serverless invocation is free to
// freeze before it ever runs once the response is sent — the real,
// production-proven cause of listings stuck at gallery_status=NOT_REQUESTED
// forever despite being enrichment-eligible. runAfterResponse() must prefer
// next/server's after() (backed by the platform's waitUntil) whenever a
// request scope is available, and fall back to the original fire-and-forget
// behavior only when after() itself throws (i.e. no request scope, exactly
// what every non-request-scoped test/script calling this module already is).

let afterCalls: Array<() => Promise<unknown>> = [];
let afterShouldThrow = false;

const nextServerUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../node_modules/next/server.js")).href;
mock.module(nextServerUrl, {
  namedExports: {
    after: (task: () => Promise<unknown>) => {
      if (afterShouldThrow) throw new Error("`after` was called outside a request scope.");
      afterCalls.push(task);
    },
  },
});

const { runAfterResponse } = await import("./run-after-response.ts");

test("inside a request scope, the task is registered with after() and not run eagerly", () => {
  afterCalls = [];
  afterShouldThrow = false;
  let ran = false;
  runAfterResponse(async () => { ran = true; });
  assert.equal(afterCalls.length, 1, "after() must be called exactly once");
  assert.equal(ran, false, "the task must not run synchronously — it is after()'s job to run it once the response is sent");
});

test("outside a request scope, after() throwing falls back to running the task directly", async () => {
  afterCalls = [];
  afterShouldThrow = true;
  let ran = false;
  runAfterResponse(async () => { ran = true; });
  await Promise.resolve();
  assert.equal(afterCalls.length, 0, "after() never actually registers anything when it throws");
  assert.equal(ran, true, "the fallback must still run the task so existing (non-request-scope) call sites keep working");
});

test("a rejected fallback task never becomes an unhandled rejection", async () => {
  afterShouldThrow = true;
  let caught = false;
  runAfterResponse(() => Promise.reject(new Error("boom")).catch(() => { caught = true; }));
  await Promise.resolve();
  assert.equal(caught, true);
});
