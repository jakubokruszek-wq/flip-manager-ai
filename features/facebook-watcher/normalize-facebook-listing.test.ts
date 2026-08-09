import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFacebookUrl } from "./normalize-facebook-listing.ts";

for (const url of [
  "https://www.facebook.com/share/p/199kRfjeGx/",
  "https://facebook.com/share/abc/",
  "https://facebook.com/groups/123/posts/456/",
  "https://facebook.com/marketplace/item/789/",
  "https://m.facebook.com/groups/123/posts/456/",
]) test(`rozpoznaje ${url}`, () => assert.ok(normalizeFacebookUrl(url)?.startsWith("https://")));

test("odrzuca domenę podszywającą się pod Facebook", () => assert.equal(normalizeFacebookUrl("https://facebook.com.example.org/share/p/1"), null));
