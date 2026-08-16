import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import type { FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { canonicalFacebookPostUrl, captureFacebookPostRegion, discoverPostLinksFromHrefs, processDedicatedFacebookPost } from "./post-page.ts";

const vision: FacebookVisionExtraction = { isProperty: true, title: "Mieszkanie Łódź", description: "Sprzedam mieszkanie 50 m²", visibleText: "Sprzedam mieszkanie 50 m²", city: "Łódź", district: null, neighborhood: null, street: null, price: 400_000, area: 50, rooms: 2, floor: null, totalFloors: null, condition: null, sellerType: "private", confidence: 0.95 };

test("deduplicates two comment links by stable post id", () => {
  const posts = discoverPostLinksFromHrefs(["https://www.facebook.com/groups/1/posts/99/?comment_id=1", "https://www.facebook.com/groups/1/posts/99/?comment_id=2"]);
  assert.deepEqual(posts, [{ postId: "99", permalink: "https://www.facebook.com/groups/1/posts/99/" }]);
  assert.equal("text" in posts[0], false);
});

test("creates a canonical permalink without tracking parameters", () => {
  assert.deepEqual(canonicalFacebookPostUrl("https://m.facebook.com/groups/test/posts/123/?__tn__=R#x"), { postId: "123", permalink: "https://www.facebook.com/groups/test/posts/123/" });
});

test("opens the dedicated page before capture and Vision", async () => {
  const order: string[] = [];
  const result = await processDedicatedFacebookPost({ postId: "99", permalink: "https://www.facebook.com/groups/1/posts/99/" }, "group-1", {
    open: async () => { order.push("open"); },
    capture: async () => { order.push("capture"); return { screenshotDataUrl: "data:image/jpeg;base64,AA==", imageUrls: ["https://scontent.xx.fbcdn.net/property.jpg"], publishedAt: null, box: { x: 0, y: 0, width: 500, height: 300 }, candidateCount: 1 }; },
    analyze: async () => { order.push("vision"); return vision; },
  });
  assert.deepEqual(order, ["open", "capture", "vision"]);
  assert.equal(result.text, vision.visibleText);
  assert.equal(result.vision, vision);
});

test("screenshots the post content region above comments", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.setContent(`<div id="post" style="width:592px;padding:12px"><a href="https://www.facebook.com/groups/1/posts/77/">Post</a><div data-testid="post_message" style="height:80px">Sprzedam mieszkanie w Łodzi, 50 m², dwa pokoje.</div><div style="height:160px"><img data-visualcompletion="media-vc-image" src="data:image/png;base64,iVBORw0KGgo=" style="width:400px;height:150px"></div><div id="comments" role="article" style="height:90px"><div dir="auto">Proszę o więcej informacji i zdjęcia</div></div></div>`);
    const commentTop = await page.locator("#comments").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const region = await captureFacebookPostRegion(page, "77");
    assert.ok(region.box.y + region.box.height <= commentTop);
    assert.match(region.screenshotDataUrl, /^data:image\/jpeg;base64,/);
  } finally { await browser.close(); }
});

test("comment-only page returns controlled region failure", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="article"><a href="https://www.facebook.com/groups/1/posts/88/?comment_id=1">Komentarz</a><div dir="auto">Proszę o priv</div></div>');
    await assert.rejects(() => captureFacebookPostRegion(page, "88"), /FACEBOOK_POST_REGION_NOT_FOUND/);
  } finally { await browser.close(); }
});
