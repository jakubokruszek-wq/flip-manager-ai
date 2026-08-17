import assert from "node:assert/strict";
import test from "node:test";
import { processDedicatedFacebookPost, resolveFacebookPostDiscovery } from "./post-page.ts";
import { runFacebookJobCompletion, waitForFacebookTargetJob } from "./job-runner.ts";
import type { FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";

const vision: FacebookVisionExtraction = {
  isProperty: true,
  listingIntent: "SELL_PROPERTY",
  intentConfidence: 1,
  confidence: 1,
  fieldConfidence: {},
  visibleText: "",
  title: null,
  price: null,
  area: null,
  rooms: null,
  city: null,
  street: null,
  neighborhood: null,
  district: null,
  floor: null,
  totalFloors: null,
  condition: null,
  sellerType: null,
  description: null,
  imageAssessments: [],
};

test("explicit post id skips discovery and completes exactly one dedicated post", async () => {
  const shutdown = new AbortController();
  const queuedJob = { id: "job-1" };
  let queuePolls = 0;
  let discoveryCalls = 0;
  let dedicatedPosts = 0;
  let completionAttempts = 0;

  const claimedJob = await waitForFacebookTargetJob({
    signal: shutdown.signal,
    pollIntervalMs: 2_000,
    claim: async () => ({ job: queuePolls++ === 0 ? null : queuedJob }),
    wait: async () => undefined,
  });
  assert.equal(claimedJob, queuedJob);

  const result = await runFacebookJobCompletion(async () => {
    const discovery = await resolveFacebookPostDiscovery({
      groupUrl: "https://www.facebook.com/groups/test-group/",
      debugPostId: "123",
      discover: async () => {
        discoveryCalls += 1;
        return { posts: [], scrollCount: 0, stopReason: "END_OF_FEED" };
      },
    });
    const posts = [];
    for (const post of discovery.posts) {
      dedicatedPosts += 1;
      posts.push(await processDedicatedFacebookPost(post, "group-1", {
        open: async () => undefined,
        capture: async () => ({ screenshotDataUrl: "data:image/jpeg;base64,AA==", imageUrls: [], publishedAt: null, authoritativePostText: "", authoritativePostTextSource: "NONE", box: { x: 0, y: 0, width: 500, height: 400 }, candidateCount: 1, screenshotWidth: 500, screenshotHeight: 400, captureMethod: "ELEMENT_SCREENSHOT", compressed: false }),
        analyze: async () => vision,
      }));
    }
    return { posts };
  }, async () => {
    completionAttempts += 1;
  });

  assert.equal(discoveryCalls, 0);
  assert.equal(queuePolls, 2);
  assert.equal(dedicatedPosts, 1);
  assert.equal(completionAttempts, 1);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].postId, "123");
  assert.equal(result.posts[0].permalink, "https://www.facebook.com/groups/test-group/posts/123/");
});
