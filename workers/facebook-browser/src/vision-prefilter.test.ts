import assert from "node:assert/strict";
import test from "node:test";
import { processDedicatedFacebookPost } from "./post-page.ts";

test("dedicated post text rejects deterministic non-sale before Vision", async () => {
  let visionCalls = 0;
  const result = await processDedicatedFacebookPost({ postId: "1", permalink: "https://www.facebook.com/groups/1/posts/1/" }, "group-1", {
    open: async () => {},
    capture: async () => ({ authoritativePostText: "Szukam mieszkania dwupokojowego", authoritativePostTextSource: "POST_REGION_DOM" as const, authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE" as const, screenshotDataUrl: "", imageUrls: [], mediaCandidates: [], publishedAt: null, box: { x: 0, y: 0, width: 1, height: 1 }, candidateCount: 1, screenshotWidth: 1, screenshotHeight: 1, captureMethod: "ELEMENT_SCREENSHOT" as const, compressed: false }),
    analyze: async () => { visionCalls += 1; throw new Error("Vision should not run"); },
  });
  assert.equal(result.vision, null);
  assert.equal(visionCalls, 0);
});
