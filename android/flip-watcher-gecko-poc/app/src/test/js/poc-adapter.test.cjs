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


test("count-only mobile DOM diagnosis finds group links even without article wrappers", () => {
  const result = adapter.inspectDomLinks({
    href: groupHref,
    roleArticles: 0, nativeArticles: 0, roleFeeds: 1,
    candidateWrappers: 2, structuredScripts: 3,
    iframeCount: 2, iframeReadable: 1, iframeInaccessible: 1,
    iframeAnchors: 17, iframeArticles: 5,
    openShadowRoots: 1, openShadowAnchors: 8, openShadowArticles: 3,
    anchors: [
      postLink(id(1)), postLink(id(1)), postLink(id(2)),
      "https://www.facebook.com/groups/402796264871862/posts/1000000000004/",
      "https://www.facebook.com/photo/?fbid=1000000000005",
      "https://www.facebook.com/",
    ],
  }, input, core);
  assert.equal(result.status, "GROUP_OK");
  assert.equal(result.counters.roleArticles, 0);
  assert.equal(result.counters.exactGroupLinks, 3);
  assert.equal(result.counters.exactGroupIds, 2);
  assert.equal(result.counters.foreignGroupLinks, 1);
  assert.equal(result.counters.photoLinks, 1);
  assert.equal(result.counters.anchorsSeen, 6);
  assert.equal(result.counters.roleFeeds, 1);
  assert.equal(result.counters.iframeCount, 2);
  assert.equal(result.counters.iframeReadable, 1);
  assert.equal(result.counters.iframeInaccessible, 1);
  assert.equal(result.counters.iframeAnchors, 17);
  assert.equal(result.counters.openShadowRoots, 1);
  assert.equal(result.counters.openShadowAnchors, 8);
  assert.ok(!JSON.stringify(result).includes(id(1)));
  assert.ok(!JSON.stringify(result).includes("https://"));
});

test("count-only diagnostics fail closed on another group or login", () => {
  const sample = { href: "https://m.facebook.com/groups/402796264871862/",
    anchors: [postLink(id(1))], roleArticles: 10 };
  const other = adapter.inspectDomLinks(sample, input, core);
  assert.equal(other.status, "WRONG_GROUP");
  assert.equal(other.counters.exactGroupLinks, 0);
  const login = adapter.inspectDomLinks({ ...sample, href: "https://m.facebook.com/login/" }, input, core);
  assert.equal(login.status, "LOGIN_REQUIRED");
  assert.equal(login.counters.anchorsSeen, 0);
});

// ---- mobile Facebook: div-only posts, ids only in page data / network bodies
const fs = require("node:fs");
const fixtures = path.resolve(__dirname, "../../main/assets/fixtures");
const FIX = "1234567890123";
const inlineScripts = name => [...fs.readFileSync(path.join(fixtures, name), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test("page scripts of a div-only feed give exact ids; comment, share, photo and unbound story are rejected", () => {
  const records = adapter.exactStructuredIds(inlineScripts("mobile-div-feed.html"), [FIX], core, "HYDRATION");
  assert.deepEqual(records.map(r => r.postId).sort(), ["550000000000001", "550000000000002"]);
  records.forEach(r => assert.equal(r.permalink, `https://www.facebook.com/groups/${FIX}/posts/${r.postId}/`));
});

test("network bodies give exact ids only for the accepted group, any FB host or permalink form", () => {
  const body = fs.readFileSync(path.join(fixtures, "mobile-net-data.html"), "utf8");
  assert.deepEqual(adapter.exactStructuredIds([body], [FIX], core, "NETWORK").map(r => r.postId).sort(), ["550000000000003", "550000000000004"]);
  assert.deepEqual(adapter.exactStructuredIds([body], ["innagrupa"], core, "NETWORK").map(r => r.postId), ["560000000000002"]);
  assert.deepEqual(adapter.exactStructuredIds([body], ["someothergroup"], core, "NETWORK"), []);
});

test("a story id without its own permalink is never accepted (no invented permalinks)", () => {
  assert.deepEqual(adapter.exactStructuredIds(inlineScripts("mobile-div-unbound.html"), [FIX], core, "HYDRATION"), []);
  assert.deepEqual(adapter.exactStructuredIds(['{"__typename":"Story","post_id":"1000000000001","url":"https://www.facebook.com/photo/?fbid=1000000000001"}'], [GROUP], core, "HYDRATION"), []);
});

test("evaluate merges DOM, page-data and network layers, dedups and caps at 20", () => {
  const net = Array.from({ length: 25 }, (_, i) => ({ postId: id(i), permalink: postLink(id(i)) }));
  const story = JSON.stringify({ __typename: "Story", post_id: id(0), url: postLink(id(0)) });
  const result = adapter.evaluate(page({ cards: [{ hrefs: [postLink(id(1))] }], structured: [story], networkRecords: net }), input, core);
  assert.equal(result.posts.length, 20);
  assert.equal(new Set(result.posts.map(p => p.postId)).size, 20);
  assert.equal(result.posts.find(p => p.postId === id(0)).idSource, "STRUCTURED");
  assert.equal(result.posts.find(p => p.postId === id(1)).idSource, "NETWORK");
});

test("network records are re-validated: foreign group, bad id, mismatched or photo permalink are dropped", () => {
  const result = adapter.evaluate(page({ networkRecords: [
    { postId: id(1), permalink: postLink(id(1)) },
    { postId: id(2), permalink: `https://www.facebook.com/groups/999999999999/posts/${id(2)}/` },
    { postId: "abc", permalink: postLink("abc") },
    { postId: id(3), permalink: postLink(id(4)) },
    { postId: id(5), permalink: `https://www.facebook.com/photo/?fbid=${id(5)}` },
    "garbage", null,
  ] }), input, core);
  assert.deepEqual(result.posts.map(p => p.postId), [id(1)]);
  assert.equal(result.diagnostics.networkRecords, 1);
});

test("id keys are counted escaped and unescaped, never their values", () => {
  const counts = adapter.countIdKeys(['{"post_id":"1"}', 'x\\"post_id\\":2 groups\\/' + GROUP + '\\/posts\\/123456789 story_fbid top_level_post_id'], [GROUP]);
  assert.deepEqual(counts, { postId: 2, topLevel: 1, storyFbid: 1, groupPermalinks: 1 });
});

test("structure verdict separates context, ids, unbound keys, missing data and markup", () => {
  const v = c => adapter.structureVerdict(c).code;
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 1, netExactIds: 3 }), "WRONG_DOCUMENT_OR_CONTEXT");
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 5, netExactIds: 3 }), "EXACT_IDS_AVAILABLE");
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 5, scriptKeyPostId: 4 }), "ID_KEYS_WITHOUT_EXACT_BINDING");
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 5, netFilterAvailable: 1, netResponses: 0, mComponents: 9 }), "NETWORK_NOT_OBSERVED_YET");
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 5, netFilterAvailable: 1, netResponses: 3 }), "NO_POST_MARKUP");
  assert.equal(v({ ctxPointsSampled: 5, ctxPointsInDocument: 5, netFilterAvailable: 1, netResponses: 3, mComponents: 40, images: 12 }), "NO_POST_IDS_IN_PAGE_DATA");
  assert.equal(adapter.structureVerdict({ mutAdded10s: 200, mutRemoved10s: 150 }).virtualized, 1);
  assert.equal(adapter.structureVerdict({ mutAdded10s: 200, mutRemoved10s: 10 }).virtualized, 0);
});
