import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import type { FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { canonicalFacebookPostUrl, captureFacebookPostRegion, collectFacebookPostTimeDiagnostic, detectFacebookPostAgeOnDedicatedPage, detectFacebookPostPublishedAt, determineFacebookPostRegionFailureReason, discoverFacebookPosts, discoverPostLinksFromHrefs, extractFacebookAuthoritativeTextFromStructuredData, extractFacebookAuthoritativeTextResolutionFromStructuredData, facebookPostFreshnessFailure, freshFacebookPosts, limitFacebookVisionPosts, parseFacebookMaxPostsArgument, parseFacebookPostIdArgument, parseFacebookTimestampValue, processDedicatedFacebookPost, rankFacebookPostRegionCandidates, resolveFacebookAuthoritativeTextSources, resolveFacebookPostAge, runFacebookDiscoveryLoop, type FacebookPostRegionDiagnosticCounts, type FacebookPostRegionRankingCandidate, type FreshDiscoveredFacebookPost } from "./post-page.ts";

const vision: FacebookVisionExtraction = { isProperty: true, listingIntent: "SELL_PROPERTY", intentConfidence: 0.98, title: "Mieszkanie Łódź", description: "Sprzedam mieszkanie 50 m²", visibleText: "Sprzedam mieszkanie 50 m²", city: "Łódź", district: null, neighborhood: null, street: null, price: 400_000, area: 50, rooms: 2, floor: null, totalFloors: null, condition: null, sellerType: "private", confidence: 0.95, imageAssessments: [] };

test("deduplicates two comment links by stable post id", () => {
  const posts = discoverPostLinksFromHrefs(["https://www.facebook.com/groups/1/posts/99/?comment_id=1", "https://www.facebook.com/groups/1/posts/99/?comment_id=2"]);
  assert.deepEqual(posts, [{ postId: "99", permalink: "https://www.facebook.com/groups/1/posts/99/" }]);
  assert.equal("text" in posts[0], false);
});

test("creates a canonical permalink without tracking parameters", () => {
  assert.deepEqual(canonicalFacebookPostUrl("https://m.facebook.com/groups/test/posts/123/?__tn__=R#x"), { postId: "123", permalink: "https://www.facebook.com/groups/test/posts/123/" });
});

test("structured metadata binds authoritative text to the exact post and ignores adjacent posts and comments", () => {
  const text = extractFacebookAuthoritativeTextFromStructuredData([{
    feed: [
      { post_id: "1646249253686136", message: { text: "Kupię za gotówkę mieszkanie w Łodzi" }, comments: [{ id: "comment-1", message: "Sprzedam mieszkanie" }] },
      { post_id: "other-post", message: "Sprzedam mieszkanie 42 m2" },
    ],
  }], "1646249253686136");
  assert.equal(text, "Kupię za gotówkę mieszkanie w Łodzi");
});

test("direct post message wins over a sale description nested under an attachment", () => {
  const resolution = extractFacebookAuthoritativeTextResolutionFromStructuredData([{
    post_id: "1646249253686136",
    message: "Kupię za gotówkę mieszkanie w Łodzi",
    attachments: [{ description: "Sprzedam mieszkanie w Łodzi", media: { caption: "Sprzedam mieszkanie" } }],
  }], "1646249253686136");
  assert.equal(resolution.text, "Kupię za gotówkę mieszkanie w Łodzi");
  assert.equal(resolution.selectedReason, "DIRECT_POST_MESSAGE");
  const selected = resolution.candidates[resolution.selectedCandidateIndex ?? -1];
  assert.deepEqual(selected.buy_signals, ["BUY_KUPIE"]);
  assert.deepEqual(selected.sell_signals, []);
  const attachment = resolution.candidates.find((candidate) => candidate.field_path_category === "ATTACHMENT_TEXT");
  assert.deepEqual(attachment?.sell_signals, ["SELL_SPRZEDAM"]);
  assert.equal(attachment?.direct_post_field, false);
});

test("outer BUY message wins over a SELL shared story bound to the same root post", () => {
  const resolution = extractFacebookAuthoritativeTextResolutionFromStructuredData([{
    post_id: "1646249253686136",
    actor: { id: "author-node" },
    message: { text: "Kupię za gotówkę mieszkanie 1-2 pokoje w Łodzi" },
    attached_story: {
      post_id: "embedded-sale-post",
      message: { text: "Sprzedam mieszkanie 42 m2 w Łodzi" },
    },
  }], "1646249253686136");
  assert.equal(resolution.outerText, "Kupię za gotówkę mieszkanie 1-2 pokoje w Łodzi");
  assert.equal(resolution.sharedText, "Sprzedam mieszkanie 42 m2 w Łodzi");
  assert.deepEqual(resolution.candidates.find((candidate) => candidate.text_layer === "OUTER_POST_TEXT")?.buy_signals, ["BUY_KUPIE"]);
  assert.deepEqual(resolution.candidates.find((candidate) => candidate.text_layer === "SHARED_POST_TEXT")?.sell_signals, ["SELL_SPRZEDAM"]);
});

test("shared post is an explicit fallback only when outer post text is empty", () => {
  const resolution = resolveFacebookAuthoritativeTextSources("", "", "Sprzedam mieszkanie 42 m2 w Łodzi", "");
  assert.equal(resolution.source, "SHARED_POST_FALLBACK");
  assert.equal(resolution.selectedLayer, "SHARED_POST_TEXT");
  assert.equal(resolution.text, "Sprzedam mieszkanie 42 m2 w Łodzi");
});

test("metadata and DOM with opposing strong signals produce a controlled source conflict", () => {
  const resolution = resolveFacebookAuthoritativeTextSources("Sprzedam mieszkanie w Łodzi", "Kupię za gotówkę mieszkanie w Łodzi");
  assert.equal(resolution.source, "CONFLICT");
  assert.equal(resolution.text, "");
  assert.equal(resolution.conflict, true);
});

test("matching metadata and DOM BUY signals keep metadata authoritative", () => {
  const resolution = resolveFacebookAuthoritativeTextSources("Kupię mieszkanie w Łodzi", "Kupię za gotówkę mieszkanie w Łodzi");
  assert.equal(resolution.source, "POST_PAGE_METADATA");
  assert.equal(resolution.text, "Kupię mieszkanie w Łodzi");
  assert.equal(resolution.conflict, false);
});

test("matching metadata and DOM SELL signals keep metadata authoritative", () => {
  const resolution = resolveFacebookAuthoritativeTextSources("Sprzedam mieszkanie w Łodzi", "Na sprzedaż mieszkanie w Łodzi");
  assert.equal(resolution.source, "POST_PAGE_METADATA");
  assert.equal(resolution.text, "Sprzedam mieszkanie w Łodzi");
  assert.equal(resolution.conflict, false);
});

test("capture reports conflict when direct metadata SELL opposes clean post-region DOM BUY", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/203/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/203/");
    const metadata = JSON.stringify({ post_id: "203", message: "Sprzedam mieszkanie w Łodzi" });
    await page.setContent(`<script type="application/json">${metadata}</script><main><section style="width:590px;height:400px"><div data-ad-comet-preview="message" style="height:80px">Kupię za gotówkę mieszkanie w Łodzi</div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='320'%3E%3C/svg%3E" style="display:block;width:590px;height:320px"></section></main>`);
    const region = await captureFacebookPostRegion(page, "203");
    assert.equal(region.authoritativePostText, "");
    assert.equal(region.authoritativePostTextSource, "CONFLICT");
  } finally { await browser.close(); }
});

test("post-region geometry keeps outer BUY separate from an embedded SELL card", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
    await page.route("https://www.facebook.com/groups/1/posts/204/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/204/");
    await page.setContent(`<main><section style="width:590px;height:600px"><div data-ad-comet-preview="message" style="height:100px">Kupię za gotówkę mieszkanie w Łodzi</div><section data-testid="shared-post" style="height:500px"><div dir="auto" style="height:80px">Sprzedam mieszkanie 42 m2 w Łodzi</div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='420'%3E%3C/svg%3E" style="display:block;width:590px;height:420px"></section></section></main>`);
    const region = await captureFacebookPostRegion(page, "204");
    assert.equal(region.authoritativePostText, "Kupię za gotówkę mieszkanie w Łodzi");
    assert.equal(region.authoritativePostTextSource, "POST_REGION_DOM");
  } finally { await browser.close(); }
});

test("capture prefers exact post metadata over neighboring sale text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/1646249253686136/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/1646249253686136/");
    const metadata = JSON.stringify({ posts: [{ post_id: "1646249253686136", message: "Kupię za gotówkę mieszkanie w Łodzi", comments: [{ message: "Sprzedam mieszkanie" }] }, { post_id: "other", message: "Sprzedam mieszkanie 42 m2" }] });
    await page.setContent(`<script type="application/json">${metadata}</script><main><section style="width:590px;height:400px"><div data-ad-comet-preview="message" style="height:80px">Tekst DOM nie ma pierwszeństwa</div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='320'%3E%3C/svg%3E" style="display:block;width:590px;height:320px"></section></main>`);
    const region = await captureFacebookPostRegion(page, "1646249253686136");
    assert.equal(region.authoritativePostText, "Kupię za gotówkę mieszkanie w Łodzi");
    assert.equal(region.authoritativePostTextSource, "POST_PAGE_METADATA");
  } finally { await browser.close(); }
});

test("post region DOM excludes comments when metadata is unavailable", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/201/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/201/");
    await page.setContent(`<main><section style="width:590px;height:520px"><section id="post" style="width:590px;height:400px"><div data-ad-comet-preview="message" style="height:80px">Kupię za gotówkę mieszkanie w Łodzi</div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='320'%3E%3C/svg%3E" style="display:block;width:590px;height:320px"></section><section aria-label="Komentarze" style="height:120px"><div dir="auto">Sprzedam mieszkanie</div></section></section></main>`);
    const region = await captureFacebookPostRegion(page, "201");
    assert.equal(region.authoritativePostText, "Kupię za gotówkę mieszkanie w Łodzi");
    assert.equal(region.authoritativePostTextSource, "POST_REGION_DOM");
    assert.doesNotMatch(region.authoritativePostText, /sprzedam/i);
  } finally { await browser.close(); }
});

test("empty metadata and DOM keep authoritative text empty for Vision fallback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/202/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/202/");
    await page.setContent(`<main><section style="width:590px;height:400px"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='400'%3E%3C/svg%3E" style="display:block;width:590px;height:400px"></section></main>`);
    const region = await captureFacebookPostRegion(page, "202");
    assert.equal(region.authoritativePostText, "");
    assert.equal(region.authoritativePostTextSource, "NONE");
  } finally { await browser.close(); }
});

test("accepts Facebook posts up to 72 hours and rejects older or unknown age", () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const published = (ageMs: number) => new Date(now - ageMs).toISOString();
  assert.equal(facebookPostFreshnessFailure(published(30 * 60_000), now), null);
  assert.equal(facebookPostFreshnessFailure(published(12 * 60 * 60_000), now), null);
  assert.equal(facebookPostFreshnessFailure(published(2 * 24 * 60 * 60_000), now), null);
  assert.equal(facebookPostFreshnessFailure(published(72 * 60 * 60_000), now), null);
  assert.equal(facebookPostFreshnessFailure(published(72 * 60 * 60_000 + 1), now), "FACEBOOK_POST_TOO_OLD");
  assert.equal(facebookPostFreshnessFailure(null, now), "FACEBOOK_POST_AGE_UNKNOWN");

  const posts: FreshDiscoveredFacebookPost[] = [
    { postId: "fresh", permalink: "https://www.facebook.com/groups/1/posts/1/", discoveredPublishedAt: published(30 * 60_000), freshnessFailure: null },
    { postId: "old", permalink: "https://www.facebook.com/groups/1/posts/2/", discoveredPublishedAt: published(73 * 60 * 60_000), freshnessFailure: "FACEBOOK_POST_TOO_OLD" },
    { postId: "unknown", permalink: "https://www.facebook.com/groups/1/posts/3/", discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" },
  ];
  assert.deepEqual(freshFacebookPosts(posts).map((post) => post.postId), ["fresh"]);
});

test("deduplicates age-aware discovery by post id before dedicated-page processing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    const publishedAt = new Date(now - 30 * 60_000).toISOString();
    await page.setContent(`<div><a href="https://www.facebook.com/groups/1/posts/999/?comment_id=1">Komentarz</a><a href="https://www.facebook.com/groups/1/posts/999/"><time datetime="${publishedAt}">30 min</time></a></div>`);
    const discovered = await discoverFacebookPosts(page, 5, now);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].postId, "999");
    assert.equal(discovered[0].freshnessFailure, null);
  } finally { await browser.close(); }
});

test("ignores a timestamp attached to a comment permalink", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    await page.setContent('<a href="https://www.facebook.com/groups/1/posts/998/?comment_id=55"><time datetime="2026-08-16T11:30:00.000Z">30 min</time></a>');
    const discovered = await discoverFacebookPosts(page, 5, now);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].freshnessFailure, "FACEBOOK_POST_AGE_UNKNOWN");
  } finally { await browser.close(); }
});

test("resolves unknown feed age from the dedicated post page before processing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    await page.route("https://www.facebook.com/groups/1/posts/997/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/997/");
    await page.setContent('<main><section role="article" style="height:300px"><time datetime="2026-08-14T12:00:00.000Z">2 dni</time></section><section aria-label="Komentarze"><time datetime="2026-08-16T11:30:00.000Z">30 min</time></section></main>');
    const unknown: FreshDiscoveredFacebookPost = { postId: "997", permalink: page.url(), discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" };
    const resolved = await resolveFacebookPostAge(unknown, now, () => detectFacebookPostPublishedAt(page, "997", now));
    assert.equal(resolved.source, "POST_PAGE");
    assert.equal(resolved.ageHours, 48);
    assert.equal(resolved.decision, "PROCESS");
  } finally { await browser.close(); }
});

test("keeps age unknown when neither feed nor dedicated page has a timestamp", async () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const unknown: FreshDiscoveredFacebookPost = { postId: "996", permalink: "https://www.facebook.com/groups/1/posts/996/", discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" };
  const resolved = await resolveFacebookPostAge(unknown, now, async () => null);
  assert.equal(resolved.source, "POST_PAGE");
  assert.equal(resolved.ageHours, null);
  assert.equal(resolved.decision, "UNKNOWN");
});

test("selects only creation_time linked to the expected post id", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const expectedPostId = "555";
    const expectedCreationTime = 1786892911;
    const now = expectedCreationTime * 1_000 + 2 * 60 * 60_000;
    await page.route("https://www.facebook.com/groups/1/posts/555/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/555/");
    await page.setContent(`<main></main><script type="application/json">${JSON.stringify([{ post_id: "other-1", creation_time: expectedCreationTime + 3_000 }, { post_id: expectedPostId, creation_time: expectedCreationTime }, { post_id: "other-2", creation_time: expectedCreationTime - 8_000 }])}</script>`);
    const detected = await detectFacebookPostAgeOnDedicatedPage(page, expectedPostId, now);
    assert.equal(detected.source, "POST_PAGE_METADATA");
    assert.equal(detected.publishedAt, new Date(expectedCreationTime * 1_000).toISOString());
    const unknown: FreshDiscoveredFacebookPost = { postId: expectedPostId, permalink: page.url(), discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" };
    const resolved = await resolveFacebookPostAge(unknown, now, async () => detected);
    assert.equal(resolved.source, "POST_PAGE_METADATA");
    assert.equal(resolved.ageHours, 2);
    assert.equal(resolved.decision, "PROCESS");
  } finally { await browser.close(); }
});

test("parses yesterday and Polish absolute Facebook timestamps", () => {
  const now = new Date(2026, 7, 16, 12, 0, 0).getTime();
  assert.ok(parseFacebookTimestampValue("wczoraj o 10:30", now));
  assert.ok(parseFacebookTimestampValue("14 sierpnia 2026 o 09:15", now));
});

test("discovery scrolls add new ids without counting duplicates", async () => {
  const post = (postId: string): FreshDiscoveredFacebookPost => ({ postId, permalink: `https://www.facebook.com/groups/1/posts/${postId}/`, discoveredPublishedAt: "2026-08-16T11:00:00.000Z", freshnessFailure: null });
  const batches = [[post("1")], [post("1"), post("2")], [post("2"), post("3")], [post("3")]];
  let collectIndex = 0;
  const result = await runFacebookDiscoveryLoop({
    collect: async () => batches[Math.min(collectIndex++, batches.length - 1)],
    scroll: async (scrollIndex) => ({ moved: scrollIndex <= 3, scrollY: scrollIndex * 700 }),
  }, { maxEmptyScrolls: 1 });
  assert.deepEqual(result.posts.map((item) => item.postId), ["1", "2", "3"]);
});

test("three empty discovery scrolls stop the loop and keep heartbeat alive", async () => {
  const initial: FreshDiscoveredFacebookPost[] = [{ postId: "1", permalink: "https://www.facebook.com/groups/1/posts/1/", discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" }];
  let heartbeatCount = 0;
  const result = await runFacebookDiscoveryLoop({ collect: async () => initial, scroll: async (index) => ({ moved: true, scrollY: index * 500 }), heartbeat: async () => { heartbeatCount += 1; } });
  assert.equal(result.stopReason, "NO_NEW_POSTS");
  assert.equal(result.scrollCount, 3);
  assert.equal(heartbeatCount, 3);
});

test("discovery stops at 50 unique posts", async () => {
  const posts = Array.from({ length: 50 }, (_, index): FreshDiscoveredFacebookPost => ({ postId: String(index), permalink: `https://www.facebook.com/groups/1/posts/${index}/`, discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" }));
  const result = await runFacebookDiscoveryLoop({ collect: async () => posts, scroll: async () => ({ moved: true, scrollY: 0 }) });
  assert.equal(result.posts.length, 50);
  assert.equal(result.stopReason, "MAX_POSTS");
});

test("discovery stops after 20 productive scrolls", async () => {
  let batch = 0;
  const result = await runFacebookDiscoveryLoop({
    collect: async () => [{ postId: String(batch++), permalink: `https://www.facebook.com/groups/1/posts/${batch}/`, discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" }],
    scroll: async (index) => ({ moved: true, scrollY: index * 500 }),
  }, { maxPosts: 100 });
  assert.equal(result.scrollCount, 20);
  assert.equal(result.stopReason, "MAX_SCROLLS");
});

test("chronological post older than 72 hours stops further discovery", async () => {
  const fresh: FreshDiscoveredFacebookPost = { postId: "fresh", permalink: "https://www.facebook.com/groups/1/posts/1/", discoveredPublishedAt: "2026-08-16T10:00:00.000Z", freshnessFailure: null };
  const old: FreshDiscoveredFacebookPost = { postId: "old", permalink: "https://www.facebook.com/groups/1/posts/2/", discoveredPublishedAt: "2026-08-12T10:00:00.000Z", freshnessFailure: "FACEBOOK_POST_TOO_OLD" };
  let batch = 0;
  const result = await runFacebookDiscoveryLoop({ collect: async () => batch++ === 0 ? [fresh] : [fresh, old], scroll: async () => ({ moved: true, scrollY: 700 }) });
  assert.equal(result.stopReason, "OLDER_THAN_72H");
  assert.equal(result.scrollCount, 1);
});

test("only fresh posts enter Vision and the per-job limit is 15", () => {
  const fresh = Array.from({ length: 18 }, (_, index): FreshDiscoveredFacebookPost => ({ postId: String(index), permalink: `https://www.facebook.com/groups/1/posts/${index}/`, discoveredPublishedAt: "2026-08-16T10:00:00.000Z", freshnessFailure: null }));
  const old: FreshDiscoveredFacebookPost = { postId: "old", permalink: "https://www.facebook.com/groups/1/posts/old/", discoveredPublishedAt: "2026-08-12T10:00:00.000Z", freshnessFailure: "FACEBOOK_POST_TOO_OLD" };
  const unknown: FreshDiscoveredFacebookPost = { postId: "unknown", permalink: "https://www.facebook.com/groups/1/posts/unknown/", discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" };
  const eligible = freshFacebookPosts([...fresh, old, unknown]);
  const limited = limitFacebookVisionPosts(eligible);
  assert.equal(limited.selected.length, 15);
  assert.equal(limited.remainingFreshCount, 3);
  assert.equal(limited.selected.some((post) => post.postId === "old" || post.postId === "unknown"), false);
});

test("time diagnostic exposes only safe structure and linked timestamp metadata", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/555/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/555/");
    await page.setContent('<main><section style="height:300px"><div data-ad-comet-preview="message">Post</div><time datetime="2026-08-16T10:00:00.000Z" aria-label="2 godziny">czas</time></section><section aria-label="Komentarze"><time data-utime="1786876200">komentarz</time></section></main><script type="application/json">{"post_id":"555","creation_time":1786874400}</script>');
    const diagnostic = await collectFacebookPostTimeDiagnostic(page, "555", Date.UTC(2026, 7, 16, 12, 0, 0));
    assert.equal(diagnostic.post_id, "555");
    assert.ok(diagnostic.candidates.some((candidate) => candidate.datetime === "2026-08-16T10:00:00.000Z" && candidate.aria_label_parseable_as_time));
    assert.ok(diagnostic.candidates.some((candidate) => candidate.inside_comment_region));
    assert.ok(diagnostic.metadata.some((item) => item.metadata_source.includes("creation_time") && item.linked_to_expected_post_id));
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /2 godziny|komentarz|ariaLabel|title":"/i);
  } finally { await browser.close(); }
});

test("opens the dedicated page before capture and Vision", async () => {
  const order: string[] = [];
  const result = await processDedicatedFacebookPost({ postId: "99", permalink: "https://www.facebook.com/groups/1/posts/99/" }, "group-1", {
    open: async () => { order.push("open"); },
    capture: async () => { order.push("capture"); return { screenshotDataUrl: "data:image/jpeg;base64,AA==", imageUrls: ["https://scontent.xx.fbcdn.net/property.jpg"], publishedAt: null, authoritativePostText: "", authoritativePostTextSource: "NONE", box: { x: 0, y: 0, width: 500, height: 300 }, candidateCount: 1, screenshotWidth: 500, screenshotHeight: 300, captureMethod: "ELEMENT_SCREENSHOT", compressed: false }; },
    analyze: async () => { order.push("vision"); return vision; },
  });
  assert.deepEqual(order, ["open", "capture", "vision"]);
  assert.equal(result.text, vision.visibleText);
  assert.equal(result.vision, vision);
});

const rankingCandidate = (changes: Partial<FacebookPostRegionRankingCandidate>): FacebookPostRegionRankingCandidate => ({
  rootIndex: 0,
  score: 1_307.98,
  area: 590 * 705,
  visible: true,
  validBoundingBox: true,
  hasContent: true,
  containsCommentSection: false,
  containsToolbar: false,
  containsForm: false,
  mediaCount: 5,
  textNodeCount: 1,
  nestingDepth: 2,
  ...changes,
});

test("clean post candidate wins over a higher-scoring dirty parent without ambiguity", () => {
  const clean = rankingCandidate({ rootIndex: 1 });
  const dirtyParent = rankingCandidate({ rootIndex: 2, score: 1_322.98, area: 590 * 982, containsCommentSection: true, containsToolbar: true, nestingDepth: 3 });
  const result = rankFacebookPostRegionCandidates([dirtyParent, clean]);
  assert.equal(result.cleanPoolUsed, true);
  assert.equal(result.ranked[0].rootIndex, clean.rootIndex);
  assert.equal(result.ranked.includes(dirtyParent), false);
  assert.equal(result.ambiguous, false);
});

test("two genuinely equivalent clean candidates remain controlled ambiguity", () => {
  const first = rankingCandidate({ rootIndex: 1 });
  const second = rankingCandidate({ rootIndex: 2, area: first.area + 50 });
  const result = rankFacebookPostRegionCandidates([first, second]);
  assert.equal(result.cleanPoolUsed, true);
  assert.equal(result.ambiguous, true);
});

test("parses the explicit one-post debug limit without changing the default", () => {
  assert.equal(parseFacebookMaxPostsArgument(["node", "index.ts"]), null);
  assert.equal(parseFacebookMaxPostsArgument(["node", "index.ts", "--max-facebook-posts=1"]), 1);
  assert.throws(() => parseFacebookMaxPostsArgument(["--max-facebook-posts=0"]), /between 1 and 15/);
});

test("parses an explicit Facebook target post id", () => {
  assert.equal(parseFacebookPostIdArgument(["node", "index.ts"]), null);
  assert.equal(parseFacebookPostIdArgument(["node", "index.ts", "--facebook-post-id=123"]), "123");
  assert.throws(() => parseFacebookPostIdArgument(["--facebook-post-id=abc"]), /only digits/);
});

test("screenshots the post content region above comments", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/77/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/77/");
    await page.setContent(`<div id="post" style="width:592px;padding:12px"><a href="https://www.facebook.com/groups/1/posts/77/">Post</a><div data-testid="post_message" style="height:80px">Sprzedam mieszkanie w Łodzi, 50 m², dwa pokoje.</div><div style="height:160px"><img data-visualcompletion="media-vc-image" src="data:image/png;base64,iVBORw0KGgo=" style="width:400px;height:150px"></div><div id="comments" role="article" style="height:90px"><div dir="auto">Proszę o więcej informacji i zdjęcia</div></div></div>`);
    const commentTop = await page.locator("#comments").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const region = await captureFacebookPostRegion(page, "77");
    assert.ok(region.box.y + region.box.height <= commentTop);
    assert.match(region.screenshotDataUrl, /^data:image\/jpeg;base64,/);
  } finally { await browser.close(); }
});

test("finds a post region on a dedicated URL without a self permalink anchor", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/123/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/123/");
    await page.setContent(`<main><section id="post" style="width:592px;padding:12px"><div data-ad-comet-preview="message" style="height:100px">Sprzedam mieszkanie w Łodzi, 50 m², dwa pokoje.</div><img data-visualcompletion="media-vc-image" src="data:image/png;base64,iVBORw0KGgo=" style="width:400px;height:180px"><section id="comments" aria-label="Komentarze" style="height:100px"><div dir="auto">Proszę o więcej informacji</div></section></section></main>`);
    assert.equal(await page.locator('a[href*="/posts/123/"]').count(), 0);
    const commentTop = await page.locator("#comments").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const region = await captureFacebookPostRegion(page, "123");
    assert.ok(region.box.y + region.box.height <= commentTop);
    assert.match(region.screenshotDataUrl, /^data:image\/jpeg;base64,/);
  } finally { await browser.close(); }
});

test("keeps the selected 367x558 candidate instead of shrinking it to a thin media clip", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/124/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/124/");
    await page.setContent(`<main><section id="post" style="box-sizing:border-box;width:367px;height:558px"><img data-visualcompletion="media-vc-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='367' height='92'%3E%3Crect width='367' height='92' fill='gold'/%3E%3C/svg%3E" style="display:block;width:367px;height:92px"></section></main>`);
    const candidateBox = await page.locator("#post").evaluate((element) => element.getBoundingClientRect().toJSON());
    const region = await captureFacebookPostRegion(page, "124");
    assert.equal(Math.round(candidateBox.width), 367);
    assert.equal(Math.round(candidateBox.height), 558);
    assert.ok(region.box.height >= 550, `Expected full candidate height, received ${region.box.height}`);
    assert.ok(region.box.height > 108 * 3);
  } finally { await browser.close(); }
});

test("image-only post keeps the complete main image above comments", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
    await page.route("https://www.facebook.com/groups/1/posts/125/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/125/");
    await page.setContent(`<main><section id="post" style="width:367px"><img id="property-image" data-visualcompletion="media-vc-image" src="data:image/png;base64,iVBORw0KGgo=" style="display:block;width:367px;height:400px"><section aria-label="Komentarze" style="height:90px"><div dir="auto">Komentarz</div></section></section></main>`);
    const mediaBox = await page.locator("#property-image").evaluate((element) => { const box = element.getBoundingClientRect(); return { top: box.top + window.scrollY, bottom: box.bottom + window.scrollY }; });
    const region = await captureFacebookPostRegion(page, "125");
    assert.ok(region.box.y <= mediaBox.top);
    assert.ok(region.box.y + region.box.height >= mediaBox.bottom);
  } finally { await browser.close(); }
});

test("media-aware fallback keeps post media when only a parent with comments is available", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.route("https://www.facebook.com/groups/1/posts/128/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/128/");
    await page.setContent(`<main><section id="post-with-comments" style="box-sizing:border-box;width:590px"><div dir="auto" style="height:80px">Sprzedam mieszkanie, 42 m², cena 339 000 zł.</div><img id="main-property-media" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='400'%3E%3Crect width='590' height='400' fill='gold'/%3E%3C/svg%3E" style="display:block;width:590px;height:400px"><section id="fallback-comments" aria-label="Komentarze" style="height:220px"><div dir="auto" style="height:40px">Komentarz</div></section></section></main>`);
    const mediaBox = await page.locator("#main-property-media").evaluate((element) => { const box = element.getBoundingClientRect(); return { top: box.top + window.scrollY, bottom: box.bottom + window.scrollY }; });
    const commentTop = await page.locator("#fallback-comments").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const region = await captureFacebookPostRegion(page, "128");
    assert.equal(region.captureMethod, "CLIP_FALLBACK");
    assert.equal(region.imageUrls.length, 1);
    assert.ok(region.box.y <= mediaBox.top);
    assert.ok(region.box.y + region.box.height >= mediaBox.bottom, `Media must fit in ${region.box.height}px screenshot`);
    assert.ok(region.box.y + region.box.height <= commentTop);
    assert.ok(region.screenshotHeight >= 470, `Expected text and media, received ${region.screenshotHeight}px`);
    assert.ok(region.screenshotHeight > 138 * 3, `Fallback must not collapse to the live 138px text-only clip`);
  } finally { await browser.close(); }
});

test("qualifies a 110x160 Facebook tile gallery while rejecting 24px and 40px icons", async () => {
  const browser = await chromium.launch({ headless: true });
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.route("https://www.facebook.com/groups/1/posts/130/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/130/");
    const deeplyWrap = (content: string, id: string) => `<a role="button" href="/photo/?fbid=${id}" style="display:inline-block;width:110px;height:160px">${'<span style="display:block;width:110px;height:160px">'.repeat(8)}${content}${"</span>".repeat(8)}</a>`;
    const tile = (index: number) => deeplyWrap(`<img data-tile="${index}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='110' height='160'%3E%3Crect width='110' height='160' fill='gold'/%3E%3C/svg%3E" style="display:block;width:110px;height:160px">`, String(index));
    const video = deeplyWrap('<video id="portrait-video" style="display:block;width:110px;height:160px"></video>', "video");
    await page.setContent(`<main><section id="tile-post" style="box-sizing:border-box;width:590px"><section id="deep-gallery" style="width:590px">${Array.from({ length: 6 }, (_, index) => tile(index)).join("")}${video}<img id="avatar-40" src="data:image/png;base64,AA==" style="width:40px;height:40px"><span role="img" id="reaction-24" style="display:inline-block;width:24px;height:24px"></span></section><section id="general-fallback" style="width:590px"><div dir="auto" style="height:80px">Sprzedam mieszkanie, 42 m², cena 339 000 zł.</div><section id="tile-comments" aria-label="Komentarze" style="height:220px"><div dir="auto" style="height:40px">Komentarz</div></section></section></section></main>`);
    await page.locator("#portrait-video").evaluate((element) => {
      Object.defineProperty(element, "videoWidth", { configurable: true, value: 720 });
      Object.defineProperty(element, "videoHeight", { configurable: true, value: 1280 });
    });
    const mediaBottom = await page.locator("#portrait-video").evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
    const commentTop = await page.locator("#tile-comments").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const region = await captureFacebookPostRegion(page, "130");
    assert.equal(region.selectedMediaCount, 7, `Expected seven post media candidates, received ${region.selectedMediaCount}`);
    assert.ok(region.imageUrls.length > 0);
    assert.ok(region.box.y + region.box.height >= mediaBottom);
    assert.ok(region.box.y + region.box.height <= commentTop);
    assert.ok(region.screenshotHeight > 138 * 2, `Tile gallery must not collapse to ${region.screenshotHeight}px`);
    const events = written.flatMap((line) => line.trim().split(/\r?\n/)).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const strategy = events.find((event) => event.event === "FACEBOOK_POST_SELECTION_STRATEGY");
    const build = events.find((event) => event.event === "FACEBOOK_MEDIA_AWARE_BUILD_DIAGNOSTIC");
    const fallback = events.find((event) => event.event === "FACEBOOK_MEDIA_FALLBACK_DIAGNOSTIC");
    assert.ok(strategy);
    assert.equal(strategy.clean_candidate_count, 0);
    assert.equal(strategy.qualified_media_count, 7);
    assert.ok(Number(strategy.fallback_candidate_count) > 0);
    assert.equal(strategy.strategy, "MEDIA_AWARE");
    assert.ok(build);
    assert.equal(build.deduped_media_count, 7);
    assert.equal(build.common_ancestor_found, true);
    assert.equal(build.ancestor_contains_comments, true);
    assert.equal(build.comment_boundary_found, true);
    assert.equal(build.media_above_comment_boundary, true);
    assert.equal(build.candidate_box_valid, true);
    assert.equal(build.rejection_reason, null);
    assert.ok(fallback, "Seven qualified media must enter MEDIA_AWARE_FALLBACK before the ordinary fallback");
    assert.equal(fallback.selected_media_count, 7);
    assert.equal(fallback.contains_comments, true);
    assert.equal(fallback.capture_method, "CLIP_FALLBACK");
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
    await browser.close();
  }
});

test("media diagnostic reports structural media sources without URLs or text", async () => {
  const browser = await chromium.launch({ headless: true });
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.route("https://www.facebook.com/groups/1/posts/129/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/129/");
    await page.setContent(`<header><img src="data:image/png;base64,AA==" alt="Autor" style="width:40px;height:40px"></header><main><section style="width:590px"><div dir="auto" style="height:80px">Treść prywatna</div><picture><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='300'%3E%3C/svg%3E" alt="Sekret" style="display:block;width:590px;height:300px"></picture><video poster="https://example.invalid/private.jpg" style="display:block;width:590px;height:200px"></video><div role="img" style="width:590px;height:120px;background-image:url('https://example.invalid/private-background.jpg')"></div><section aria-label="Komentarze"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3C/svg%3E" style="width:300px;height:200px"></section></section></main>`);
    await captureFacebookPostRegion(page, "129", { mediaDiagnostic: true });
    const events = written.flatMap((line) => line.trim().split(/\r?\n/)).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const diagnostic = events.find((event) => event.event === "FACEBOOK_MEDIA_DISCOVERY_DIAGNOSTIC");
    assert.ok(diagnostic);
    const serialized = JSON.stringify(diagnostic);
    assert.match(serialized, /PICTURE|VIDEO|POSTER|ROLE_IMG|BACKGROUND/);
    assert.match(serialized, /COMMENT_REGION/);
    assert.doesNotMatch(serialized, /example\.invalid|Treść prywatna|Sekret|data:image/);
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
    await browser.close();
  }
});

test("clean image and video region wins over its dirty parent and keeps the full screenshot", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1_200 } });
    await page.route("https://www.facebook.com/groups/1/posts/126/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/126/");
    await page.setContent(`<main><section id="dirty" style="width:590px;height:982px"><section id="clean" style="box-sizing:border-box;width:590px;height:705px"><img data-visualcompletion="media-vc-image" src="data:image/png;base64,iVBORw0KGgo=" style="display:block;width:590px;height:360px"><video style="display:block;width:590px;height:345px"></video></section><div role="toolbar" style="height:70px"></div><section aria-label="Komentarze" style="height:207px"><img src="data:image/png;base64,iVBORw0KGgo=" style="width:100px;height:100px"></section></section></main>`);
    const cleanBox = await page.locator("#clean").evaluate((element) => element.getBoundingClientRect().toJSON());
    const region = await captureFacebookPostRegion(page, "126");
    assert.equal(region.captureMethod, "ELEMENT_SCREENSHOT");
    assert.equal(region.screenshotHeight, 705);
    assert.equal(Math.round(region.box.width), Math.round(cleanBox.width));
    assert.ok(region.box.height >= 700, `Expected full clean region, received ${region.box.height}`);
    assert.ok(region.box.height < 800, `Dirty parent must not be selected: ${region.box.height}`);
  } finally { await browser.close(); }
});

test("element screenshot captures the full 590x705 post below the viewport fold", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1_280, height: 720 } });
    await page.route("https://www.facebook.com/groups/1/posts/127/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://www.facebook.com/groups/1/posts/127/");
    await page.setContent(`<main><div style="height:600px"></div><section id="dirty" style="width:590px;height:982px"><section id="clean" style="box-sizing:border-box;width:590px;height:705px"><img data-visualcompletion="media-vc-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='350'%3E%3Crect width='590' height='350' fill='red'/%3E%3C/svg%3E" style="display:block;width:590px;height:350px"><img id="below-fold-media" data-visualcompletion="media-vc-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='590' height='355'%3E%3Crect width='590' height='355' fill='blue'/%3E%3C/svg%3E" style="display:block;width:590px;height:355px"></section><div role="toolbar" style="height:70px"></div><section id="comments" aria-label="Komentarze" style="height:207px"></section></section></main>`);
    const initial = await page.locator("#clean").evaluate((element) => { const box = element.getBoundingClientRect(); const media = document.querySelector("#below-fold-media")!.getBoundingClientRect(); return { top: box.top, height: box.height, mediaTop: media.top, viewportHeight: window.innerHeight }; });
    assert.ok(initial.top < initial.viewportHeight);
    assert.ok(initial.top + initial.height > initial.viewportHeight);
    assert.ok(initial.mediaTop > initial.viewportHeight);
    const region = await captureFacebookPostRegion(page, "127");
    assert.equal(region.captureMethod, "ELEMENT_SCREENSHOT");
    assert.equal(region.screenshotWidth, 590);
    assert.equal(region.screenshotHeight, 705);
    assert.equal(region.imageUrls.length, 2);
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

test("classifies structural post region failure reasons", () => {
  const valid: FacebookPostRegionDiagnosticCounts = {
    dedicatedPageUrlMatches: true,
    canonicalAnchorCount: 1,
    candidateAncestorCount: 4,
    candidatesAfterSizeFilter: 2,
    candidatesAfterContentFilter: 2,
    candidatesAfterCommentFilter: 2,
    candidatesAfterVisibilityFilter: 1,
    validBoundingBoxCount: 1,
    ambiguousTopCandidates: false,
  };
  const reason = (changes: Partial<FacebookPostRegionDiagnosticCounts>) => determineFacebookPostRegionFailureReason({ ...valid, ...changes });
  assert.equal(reason({ dedicatedPageUrlMatches: false, canonicalAnchorCount: 0 }), "POST_ANCHOR_NOT_FOUND");
  assert.equal(reason({ candidateAncestorCount: 0 }), "NO_ANCESTOR_CANDIDATES");
  assert.equal(reason({ candidatesAfterSizeFilter: 0 }), "ALL_TOO_SMALL");
  assert.equal(reason({ candidatesAfterContentFilter: 0 }), "NO_CONTENT_NODES");
  assert.equal(reason({ candidatesAfterCommentFilter: 0 }), "ALL_REJECTED_AS_COMMENTS");
  assert.equal(reason({ candidatesAfterVisibilityFilter: 0 }), "INVALID_BOUNDING_BOX");
  assert.equal(reason({ validBoundingBoxCount: 0 }), "INVALID_BOUNDING_BOX");
  assert.equal(reason({ ambiguousTopCandidates: true }), "AMBIGUOUS_CANDIDATES");
  assert.equal(reason({}), "UNKNOWN");
});
