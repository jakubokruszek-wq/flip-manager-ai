import assert from "node:assert/strict";
import test from "node:test";
import { withTransientRetry } from "./retry.ts";

test("a lost lease aborts transient retry before issuing a second scrape", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(withTransientRetry(async () => {
    attempts += 1;
    controller.abort(new Error("lease lost"));
    throw new Error("transient scrape error");
  }, 1, controller.signal), /lease lost/);
  assert.equal(attempts, 1);
});
