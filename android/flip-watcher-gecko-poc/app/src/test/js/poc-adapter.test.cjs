/* Node tests of the POC decision layer over the unchanged collector-core.js.
 * Run: node --test android/flip-watcher-gecko-poc/app/src/test/js/ */
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
require(path.resolve(__dirname, "../../../../../../extensions/facebook-collector/collector-core.js"));
require(path.resolve(__dirname, "../../main/extension/poc-adapter.js"));

const core = globalThis.FlipFacebookCollectorCore;
const adapter = globalThis.FlipGeckoPocAdapter;
const GROUP = "lodzsprzedazzakupwynajem";
const OLD_NUMERIC_GROUP = "402796264871862";
const input = { groupId: GROUP, maxPosts: 20 };
const groupHref = `https://m.facebook.com/groups/${GROUP}/`;
const postLink = id => `https://www.facebook.com/groups/${GROUP}/posts/${id}/`;
const id = n => String(1_000_000_000_000 + n);

function page(extra = {}) {
  return { href: groupHref, bodyTextSample: "", hasPasswordInput: false, hasLoginForm: false, hasCaptcha: false, cards: [], structured: [], ...extra };
}

test("keeps only cards with exactly one post id of the approved group", () => {
  const result = adapter.evaluate(page({
    cards: [
      { hrefs: [postLink(id(1)), `https://www.facebook.com/profile.php?id=42`] },
      { hrefs: [postLink(id(2)), postLink(id(2)) + "?comment_id=9"] },
      { hrefs: [postLink(id(3)), postLink(id(4))] },
      { hrefs: ["https://www.facebook.com/photo/?fbid=1234567890123&set=g.1"] },
      { hrefs: ["https://www.facebook.com/groups/999999999999/posts/1234567890123/"] },
      { hrefs: [] },
    ],
  }), input, core);
  assert.equal(result.status, "OK");
  assert.deepEqual(result.posts.map(post => post.postId), [id(1), id(2)]);
  assert.equal(result.posts[0].permalink, postLink(id(1)));
  assert.equal(result.diagnostics.ambiguousCards, 1);
  assert.equal(result.diagnostics.foreignCards, 1);
  assert.equal(result.diagnostics.cardsWithoutId, 2);
});

test("photo fbid is never taken as a post id", () => {
  const result = adapter.evaluate(page({ cards: [{ hrefs: [`https://www.facebook.com/photo.php?fbid=${id(7)}`] }] }), input, core);
  assert.equal(result.status, "NO_POSTS");
  assert.equal(result.posts.length, 0);
});

test("duplicates across cards and structured payloads collapse to one id", () => {
  const story = JSON.stringify({ __typename: "Story", post_id: id(1), permalink_url: postLink(id(1)), message: { text: "Sprzedam 2 pokoje" }, actor: { name: "A" } });
  const result = adapter.evaluate(page({ cards: [{ hrefs: [postLink(id(1))] }, { hrefs: [postLink(id(1))] }], structured: [story] }), input, core);
  assert.deepEqual(result.posts.map(post => post.postId), [id(1)]);
  assert.equal(result.posts[0].idSource, "STRUCTURED");
  assert.equal(result.diagnostics.duplicatesDropped, 2);
});

test("caps the result at 20 posts even when more are asked", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ hrefs: [postLink(id(i))] }));
  const result = adapter.evaluate(page({ cards }), { groupId: GROUP, maxPosts: 50 }, core);
  assert.equal(result.posts.length, 20);
  assert.equal(new Set(result.posts.map(post => post.postId)).size, 20);
  assert.equal(result.diagnostics.overLimitDropped, 10);
});

test("stops with a clear state on checkpoint, captcha, login and lost access", () => {
  const cards = [{ hrefs: [postLink(id(1))] }];
  assert.equal(adapter.evaluate(page({ href: "https://m.facebook.com/checkpoint/1501092823525282/", cards }), input, core).status, "CHECKPOINT");
  assert.equal(adapter.evaluate(page({ href: "https://www.facebook.com/two_step_verification/two_factor/", cards }), input, core).status, "CHECKPOINT");
  assert.equal(adapter.evaluate(page({ hasCaptcha: true, cards }), input, core).status, "CAPTCHA");
  assert.equal(adapter.evaluate(page({ href: "https://m.facebook.com/login/?next=x", cards }), input, core).status, "LOGIN_REQUIRED");
  assert.equal(adapter.evaluate(page({ hasPasswordInput: true, cards }), input, core).status, "LOGIN_REQUIRED");
  const unavailable = adapter.evaluate(page({ bodyTextSample: "Ta zawartość jest niedostępna", cards }), input, core);
  assert.equal(unavailable.status, "GROUP_UNAVAILABLE");
  // A stop never returns posts.
  assert.deepEqual(unavailable.posts, []);
});

test("another group, another host or a lookalike host is WRONG_GROUP", () => {
  const cards = [{ hrefs: [postLink(id(1))] }];
  assert.equal(adapter.evaluate(page({ href: "https://m.facebook.com/groups/123456789/", cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: `https://m.facebook.com.evil.example/groups/${GROUP}/`, cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: `http://m.facebook.com/groups/${GROUP}/`, cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: `https://m.facebook.com/groups/${GROUP}/members/`, cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: `https://www.facebook.com/groups/${OLD_NUMERIC_GROUP}/`, cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: "https://www.facebook.com/groups/1350200629551011/", cards }), input, core).status, "WRONG_GROUP");
});

test("loopback pages are accepted only when the app asks for fixture mode", () => {
  const cards = [{ hrefs: [postLink(id(1))] }];
  const href = `http://127.0.0.1:41234/groups/${GROUP}/?fixture=feed-basic`;
  assert.equal(adapter.evaluate(page({ href, cards }), input, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href, cards }), { ...input, allowLoopback: true }, core).status, "OK");
});

test("fails loudly without the collector core", () => {
  assert.throws(() => adapter.evaluate(page(), input, undefined), /COLLECTOR_CORE_MISSING/);
});

// ---- hypothetical verified aliases (the approved source remains the standalone slug)
const SLUG = "verifiedslugtest";
const slugHref = `https://www.facebook.com/groups/${SLUG}/`;
const slugLink = n => `https://www.facebook.com/groups/${SLUG}/posts/${n}/`;
const withAlias = { groupId: GROUP, maxPosts: 20, aliases: [SLUG] };

test("a slug page is WRONG_GROUP unless the app sends it as a verified alias", () => {
  const cards = [{ hrefs: [slugLink(id(1))] }];
  assert.equal(adapter.evaluate(page({ href: slugHref, cards }), input, core).status, "WRONG_GROUP");
  const result = adapter.evaluate(page({ href: slugHref, cards }), withAlias, core);
  assert.equal(result.status, "OK");
  // Identity stays the canonical independently approved group source.
  assert.deepEqual(result.posts, [{ postId: id(1), permalink: postLink(id(1)), idSource: "DOM_LINK" }]);
});

test("an alias never opens other groups: foreign slug, foreign numeric, unverified alias", () => {
  const cards = [
    { hrefs: [slugLink(id(1))] },
    { hrefs: ["https://www.facebook.com/groups/innagrupa/posts/1000000000099/"] },
    { hrefs: ["https://www.facebook.com/groups/999999999999/posts/1000000000098/"] },
    { hrefs: [slugLink(id(2)), "https://www.facebook.com/groups/innagrupa/posts/1000000000097/"] },
  ];
  const result = adapter.evaluate(page({ href: slugHref, cards }), withAlias, core);
  assert.deepEqual(result.posts.map(post => post.postId), [id(1)]);
  assert.equal(result.diagnostics.foreignCards, 2);
  assert.equal(result.diagnostics.ambiguousCards, 1);
  assert.equal(adapter.evaluate(page({ href: "https://www.facebook.com/groups/innagrupa/", cards }), withAlias, core).status, "WRONG_GROUP");
  assert.equal(adapter.evaluate(page({ href: slugHref, cards }), { ...withAlias, aliases: ["../x", 5, null] }, core).status, "WRONG_GROUP");
});

test("slug and numeric forms of the same post are one post; invalid permalinks are dropped", () => {
  const story = JSON.stringify({ __typename: "Story", post_id: id(3), permalink_url: slugLink(id(3)), message: { text: "Sprzedam" }, actor: { name: "A" } });
  const result = adapter.evaluate(page({
    href: slugHref,
    cards: [{ hrefs: [slugLink(id(1))] }, { hrefs: [postLink(id(1))] }, { hrefs: [`https://www.facebook.com/groups/${SLUG}/posts/abc/`] }, { hrefs: [`https://www.facebook.com/groups/${SLUG}/posts/123/`] }],
    structured: [story],
  }), withAlias, core);
  assert.deepEqual(result.posts.map(post => post.postId).sort(), [id(1), id(3)]);
  result.posts.forEach(post => assert.equal(post.permalink, postLink(post.postId)));
  assert.equal(result.diagnostics.duplicatesDropped, 1);
  assert.equal(result.diagnostics.cardsWithoutId, 2);
});

test("the 20-post limit holds with aliases", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ hrefs: [i % 2 ? slugLink(id(i)) : postLink(id(i))] }));
  const result = adapter.evaluate(page({ href: slugHref, cards }), { ...withAlias, maxPosts: 99 }, core);
  assert.equal(result.posts.length, 20);
  assert.equal(new Set(result.posts.map(post => post.postId)).size, 20);
});

test("group identity reads only Facebook's app-link metadata as strong evidence", () => {
  const hits = adapter.groupIdentity({
    metaTags: [{ property: "al:android:url", content: `fb://group/${OLD_NUMERIC_GROUP}` }, { property: "al:ios:url", content: `fb://group/?id=${OLD_NUMERIC_GROUP}` }, { property: "og:title", content: "fb://group/1111111111" }],
    alternateLinks: ["android-app://com.facebook.katana/fb/group/2222222222"],
    scriptTexts: ['{"groupID":"3333333333","x":{"group_id":"3333333333"}}', '{"groupID":"4444444444"}'],
  });
  assert.deepEqual(hits.filter(hit => hit.source.startsWith("al:")).map(hit => hit.id), [OLD_NUMERIC_GROUP, OLD_NUMERIC_GROUP]);
  assert.ok(!hits.some(hit => hit.id === "1111111111"));
  assert.ok(hits.some(hit => hit.id === "3333333333" && hit.source === "json×2"));
});
