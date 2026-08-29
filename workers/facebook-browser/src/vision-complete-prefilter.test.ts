import assert from "node:assert/strict";
import test from "node:test";
import { processDedicatedFacebookPost } from "./post-page.ts";

const region = (text: string) => ({
  authoritativePostText: text,
  authoritativePostTextSource: "POST_REGION_DOM" as const,
  authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE" as const,
  screenshotDataUrl: "",
  imageUrls: [],
  mediaCandidates: [],
  publishedAt: null,
  box: { x: 0, y: 0, width: 1, height: 1 },
  candidateCount: 1,
  screenshotWidth: 1,
  screenshotHeight: 1,
  captureMethod: "ELEMENT_SCREENSHOT" as const,
  compressed: false,
});

test("complete textual SELL skips Vision", async () => {
  let visionCalls = 0;
  const result = await processDedicatedFacebookPost({ postId: "1", permalink: "https://www.facebook.com/groups/2928219830782023/posts/1/" }, "group", {
    open: async () => undefined,
    capture: async () => region("Sprzedam mieszkanie M3, 64 m2, 9200 z\u0142/m2"),
    analyze: async () => { visionCalls += 1; throw new Error("Vision should not run"); },
  });
  assert.equal(result.vision, null);
  assert.equal(visionCalls, 0);
});

test("unresolved SELL invokes Vision at most once", async () => {
  let visionCalls = 0;
  await processDedicatedFacebookPost({ postId: "2", permalink: "https://www.facebook.com/groups/2928219830782023/posts/2/" }, "group", {
    open: async () => undefined,
    capture: async () => region("Sprzedam mieszkanie w \u0141odzi"),
    analyze: async () => {
      visionCalls += 1;
      return { isProperty: true, listingIntent: "SELL_PROPERTY", intentConfidence: 1, title: null, description: null, visibleText: null, city: null, district: null, neighborhood: null, street: null, price: null, area: null, rooms: null, floor: null, totalFloors: null, condition: null, sellerType: null, confidence: 1, imageAssessments: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "test", estimatedCostUsd: 0, pricingSourceModel: "test", pricingVersion: "test", dataQuality: "EXACT" } };
    },
  });
  assert.equal(visionCalls, 1);
});
