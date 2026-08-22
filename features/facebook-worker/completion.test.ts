import assert from "node:assert/strict";
import test from "node:test";
import { assertFacebookPostsBelongToGroup, parseFacebookCompletionPayload, parseFacebookGroupSnapshot } from "./completion.ts";

const groupA = { id: "group-a", name: "Group A", url: "https://www.facebook.com/groups/group-a/" };
const groupB = { id: "group-b", name: "Group B", url: "https://www.facebook.com/groups/group-b/" };

test("parses exactly one group bound to a queue job", () => assert.deepEqual(parseFacebookGroupSnapshot([groupA]), groupA));
test("job A accepts only posts from group A", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-a" }], groupA)));
test("job B accepts only posts from group B", () => assert.doesNotThrow(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupB)));
test("completion rejects a post from another group", () => assert.throws(() => assertFacebookPostsBelongToGroup([{ groupId: "group-b" }], groupA), /FACEBOOK_GROUP_MISMATCH/));

test("completion accepts a server-verifiable cache reference and performance metrics", () => {
  const completion = parseFacebookCompletionPayload({
    jobId: "job-2", leaseToken: "lease-2", workerId: "worker-2", warnings: [], durationMs: 100,
    performance: { postsDiscovered: 1, discoveredPostIds: ["123"], duplicatePostIdsSkipped: 1, pageOpens: 1, visionCalls: 0, visionCacheHits: 1, knownPostSkips: 1, discoveryScrolls: 0 },
    posts: [{ postId: "123", groupId: "group-b", permalink: "https://www.facebook.com/groups/group-b/posts/123/", text: "", imageUrls: [], publishedAt: "2026-08-22T10:00:00.000Z", vision: null, cacheHit: { sourceJobId: "job-1", listingId: "listing-1", analyzedAt: "2026-08-22T10:01:00.000Z", scope: "RUN" } }],
  });
  assert.equal(completion.posts[0].cacheHit?.listingId, "listing-1");
  assert.equal(completion.performance.visionCalls, 0);
});
