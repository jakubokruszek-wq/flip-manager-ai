import assert from "node:assert/strict";
import test from "node:test";

import { safeFacebookPostUrl } from "./facebook-post-url.ts";

test("accepts both canonical Facebook group post URL shapes", () => {
  assert.equal(safeFacebookPostUrl("https://www.facebook.com/groups/lodz/posts/1584981246653352"), "https://www.facebook.com/groups/lodz/posts/1584981246653352");
  assert.equal(safeFacebookPostUrl("https://www.facebook.com/groups/lodz/permalink/1584981246653352/"), "https://www.facebook.com/groups/lodz/permalink/1584981246653352/");
});

test("rejects non-root or non-Facebook URLs", () => {
  assert.equal(safeFacebookPostUrl("https://www.facebook.com/photo/?fbid=1584981246653352"), null);
  assert.equal(safeFacebookPostUrl("https://example.com/groups/lodz/posts/1584981246653352"), null);
  assert.equal(safeFacebookPostUrl("https://www.facebook.com/groups/lodz/posts/not-an-id"), null);
});
