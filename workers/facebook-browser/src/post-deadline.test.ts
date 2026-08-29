import assert from "node:assert/strict";
import test from "node:test";
import { facebookPostDeadlineForSource, FacebookPostProcessingDeadlineError, runFacebookPostWithDeadline } from "./post-deadline.ts";

test("deadline is scoped to group 2928219830782023", () => {
  assert.equal(facebookPostDeadlineForSource("https://www.facebook.com/groups/2928219830782023/"), 25_000);
  assert.equal(facebookPostDeadlineForSource("https://www.facebook.com/groups/123/"), null);
});

test("slow post is skipped and the next post continues", async () => {
  const completed: string[] = [];
  for (const postId of ["slow", "next"]) {
    try {
      await runFacebookPostWithDeadline(postId, async () => {
        if (postId === "slow") await new Promise<void>(() => undefined);
        completed.push(postId);
      }, async () => undefined, 5);
    } catch (error) {
      assert.ok(error instanceof FacebookPostProcessingDeadlineError);
    }
  }
  assert.deepEqual(completed, ["next"]);
});

test("normal post completes without invoking recovery", async () => {
  let recovered = false;
  const result = await runFacebookPostWithDeadline("ok", async () => "done", async () => { recovered = true; }, 50);
  assert.equal(result, "done");
  assert.equal(recovered, false);
});
