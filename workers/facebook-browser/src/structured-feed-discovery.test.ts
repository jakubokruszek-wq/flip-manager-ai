import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacebookStructuredFeedRecords } from "./structured-feed-discovery.ts";

const now = Date.UTC(2026, 7, 29, 12);

test("discovers exact structured group posts and permalink variants", () => {
  const posts = resolveFacebookStructuredFeedRecords([
    { postId: "101", url: "https://www.facebook.com/groups/125/permalink/101/?tracking=1", publishedAt: now / 1_000 - 60, unsafeContext: false },
    { postId: "102", url: "https://www.facebook.com/groups/125/posts/102/", publishedAt: new Date(now - 120_000).toISOString(), unsafeContext: false },
  ], "125", now);
  assert.deepEqual(posts.map(({ postId, permalink, freshnessFailure }) => ({ postId, permalink, freshnessFailure })), [
    { postId: "101", permalink: "https://www.facebook.com/groups/125/posts/101/", freshnessFailure: null },
    { postId: "102", permalink: "https://www.facebook.com/groups/125/posts/102/", freshnessFailure: null },
  ]);
});

test("rejects foreign groups, mismatched ids, and broad or non-post URLs", () => {
  const posts = resolveFacebookStructuredFeedRecords([
    { postId: "101", url: "https://www.facebook.com/groups/999/posts/101/", publishedAt: null, unsafeContext: false },
    { postId: "101", url: "https://www.facebook.com/groups/125/posts/202/", publishedAt: null, unsafeContext: false },
    { postId: "101", url: "https://www.facebook.com/groups/125/", publishedAt: null, unsafeContext: false },
    { postId: "101", url: "https://www.facebook.com/reel/101/", publishedAt: null, unsafeContext: false },
  ], "125", now);
  assert.deepEqual(posts, []);
});

test("rejects attached, shared, comment, and sibling structured contexts", () => {
  const posts = resolveFacebookStructuredFeedRecords([
    { postId: "101", url: "https://www.facebook.com/groups/125/posts/101/", publishedAt: null, unsafeContext: true },
    { postId: "102", url: "https://www.facebook.com/groups/125/permalink/102/", publishedAt: null, unsafeContext: true },
  ], "125", now);
  assert.deepEqual(posts, []);
});

test("deduplicates the same exact structured post and keeps its timestamp", () => {
  const posts = resolveFacebookStructuredFeedRecords([
    { postId: "101", url: "https://www.facebook.com/groups/125/posts/101/", publishedAt: null, unsafeContext: false },
    { postId: "101", url: "https://www.facebook.com/groups/125/permalink/101/", publishedAt: now / 1_000 - 60, unsafeContext: false },
  ], "125", now);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].discoveredPublishedAt, new Date(now - 60_000).toISOString());
});

test("preserves exact structured post text for deterministic feed filtering", () => {
  const [post] = resolveFacebookStructuredFeedRecords([
    { postId: "103", url: "https://www.facebook.com/groups/125/posts/103/", publishedAt: null, unsafeContext: false, text: "Szukam mieszkania do wynajęcia" },
  ], "125", now);
  assert.equal(post.discoveredText, "Szukam mieszkania do wynajęcia");
});
