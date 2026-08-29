import assert from "node:assert/strict";
import test from "node:test";
import { facebookPostDeadlineForSource, FacebookPostProcessingDeadlineError, mapFacebookPostsWithConcurrency, runFacebookPostWithDeadline } from "./post-deadline.ts";

test("deadline is scoped to group 2928219830782023", () => {
  assert.equal(facebookPostDeadlineForSource("https://www.facebook.com/groups/2928219830782023/"), 20_000);
  assert.equal(facebookPostDeadlineForSource("https://www.facebook.com/groups/123/"), null);
});

test("bounded processing never exceeds configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  await mapFacebookPostsWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  });
  assert.equal(peak, 2);
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
