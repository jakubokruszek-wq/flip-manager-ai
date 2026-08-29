import assert from "node:assert/strict";
import test from "node:test";
import { runFacebookDiscoveryLoop } from "./post-page.ts";
import type { FreshDiscoveredFacebookPost } from "./post-page.ts";

const post = (id: string): FreshDiscoveredFacebookPost => ({
  postId: id,
  permalink: `https://www.facebook.com/groups/1/posts/${id}/`,
  discoveredPublishedAt: "2026-08-29T10:00:00.000Z",
  freshnessFailure: null,
});

test("structured hydration batches continue discovery beyond the first anchor post", async () => {
  let batch = 0;
  const result = await runFacebookDiscoveryLoop({
    collect: async () => {
      batch += 1;
      return batch === 1 ? [post("anchor")] : [post("anchor"), post(`hydrated-${batch}`)];
    },
    scroll: async (index) => ({ moved: index < 2, scrollY: index * 700 }),
  }, { maxPosts: 10, maxScrolls: 3, maxEmptyScrolls: 3 });

  assert.deepEqual(result.posts.map((item) => item.postId), ["anchor", "hydrated-2"]);
  assert.equal(result.stopReason, "END_OF_FEED");
  assert.equal(result.scrollCount, 2);
});
