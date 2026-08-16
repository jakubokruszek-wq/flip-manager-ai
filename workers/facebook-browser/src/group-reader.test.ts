import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { parseFacebookGroupSnapshot } from "../../../features/facebook-worker/completion.ts";
import { assertWorkerFacebookGroupUrl, readFacebookGroup } from "./group-reader.ts";
import { cleanFacebookPostText, normalizeFacebookPosts } from "./post-extractor.ts";

test("accepts one configured Facebook group", () => assert.equal(assertWorkerFacebookGroupUrl("https://www.facebook.com/groups/123/").pathname, "/groups/123/"));
test("rejects missing group snapshot", () => assert.throws(() => parseFacebookGroupSnapshot([]), /FACEBOOK_GROUP_REQUIRED/));
test("rejects non-Facebook host", () => assert.throws(() => assertWorkerFacebookGroupUrl("https://facebook.com.example.org/groups/123"), /FACEBOOK_GROUP_URL_NOT_ALLOWED/));
test("normalizes and limits extracted posts", () => { const posts = normalizeFacebookPosts("group-1", [{ permalink: "https://www.facebook.com/groups/1/posts/99/", text: "x".repeat(2_100), imageUrls: Array(7).fill("https://scontent.xx.fbcdn.net/a.jpg") }]); assert.equal(posts.length, 1); assert.equal(posts[0].postId, "99"); assert.equal(posts[0].text.length, 2_000); assert.equal(posts[0].imageUrls.length, 5); });

test("extracts the main post body and excludes nested comments and UI strings", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <article role="article">
        <a href="https://www.facebook.com/groups/1/posts/99/?__tn__=R">2 godz.</a>
        <div data-ad-comet-preview="message">Sprzedam mieszkanie 45 m², 2 pokoje, Łódź Bałuty.</div>
        <a href="https://www.facebook.com/photo/?fbid=1"><img src="https://scontent.xx.fbcdn.net/property.jpg" alt="Salon"></a>
        <div role="article">
          <a href="https://www.facebook.com/groups/1/posts/99/?comment_id=5">Komentarz</a>
          <div data-ad-comet-preview="message">Proszę o priv</div>
          <button>Lubię to!</button><button>Odpowiedz</button><button>Udostępnij</button>
        </div>
      </article>
    `);
    const result = await readFacebookGroup(page, { id: "group-1", name: "Fixture", url: "https://www.facebook.com/groups/1/" });
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].postId, "99");
    assert.equal(result.posts[0].text, "Sprzedam mieszkanie 45 m², 2 pokoje, Łódź Bałuty.");
    assert.deepEqual(result.posts[0].imageUrls, ["https://scontent.xx.fbcdn.net/property.jpg"]);
    assert.doesNotMatch(result.posts[0].text, /Proszę o priv|Lubię to|Odpowiedz|Udostępnij/);
  } finally { await browser.close(); }
});

test("removes Facebook action labels from normalized text", () => {
  assert.equal(cleanFacebookPostText("Sprzedam mieszkanie Lubię to! Odpowiedz Udostępnij"), "Sprzedam mieszkanie");
});

test("ambiguous article becomes controlled extraction warning", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<article role="article"><a href="https://www.facebook.com/groups/1/posts/100/">1 godz.</a><div role="article"><div data-ad-comet-preview="message">Proszę o priv</div></div></article>');
    const result = await readFacebookGroup(page, { id: "group-1", name: "Fixture", url: "https://www.facebook.com/groups/1/" });
    assert.equal(result.posts.length, 0);
    assert.match(result.warnings[0], /FACEBOOK_POST_BODY_NOT_FOUND/);
  } finally { await browser.close(); }
});
