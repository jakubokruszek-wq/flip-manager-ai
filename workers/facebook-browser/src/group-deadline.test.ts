import assert from "node:assert/strict";
import test from "node:test";
import { runWithFacebookGroupDeadline } from "./group-deadline.ts";

test("group deadline lets a normal operation finish", async () => {
  assert.equal(await runWithFacebookGroupDeadline(async () => "ok", new AbortController().signal, 50), "ok");
});

test("group deadline fails stalled work with a controlled timeout", async () => {
  await assert.rejects(() => runWithFacebookGroupDeadline(() => new Promise(() => {}), new AbortController().signal, 5), /FACEBOOK_GROUP_DEADLINE_EXCEEDED/);
});
