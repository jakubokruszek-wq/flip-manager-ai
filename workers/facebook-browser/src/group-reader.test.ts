import assert from "node:assert/strict";
import test from "node:test";
import { parseFacebookGroupSnapshot } from "../../../features/facebook-worker/completion.ts";
import { assertWorkerFacebookGroupUrl } from "./group-reader.ts";
import { normalizeFacebookPosts } from "./post-extractor.ts";

test("accepts one configured Facebook group", () => assert.equal(assertWorkerFacebookGroupUrl("https://www.facebook.com/groups/123/").pathname, "/groups/123/"));
test("rejects missing group snapshot", () => assert.throws(() => parseFacebookGroupSnapshot([]), /FACEBOOK_GROUP_REQUIRED/));
test("rejects non-Facebook host", () => assert.throws(() => assertWorkerFacebookGroupUrl("https://facebook.com.example.org/groups/123"), /FACEBOOK_GROUP_URL_NOT_ALLOWED/));
test("normalizes and limits extracted posts", () => { const posts = normalizeFacebookPosts("group-1", [{ permalink: "https://www.facebook.com/groups/1/posts/99/", text: "x".repeat(2_100), imageUrls: Array(7).fill("https://scontent.xx.fbcdn.net/a.jpg") }]); assert.equal(posts.length, 1); assert.equal(posts[0].postId, "99"); assert.equal(posts[0].text.length, 2_000); assert.equal(posts[0].imageUrls.length, 5); });
