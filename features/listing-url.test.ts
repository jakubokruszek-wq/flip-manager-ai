import assert from "node:assert/strict";
import test from "node:test";

import { resolveListingUrl } from "./listing-url.ts";

test("Facebook prefers authoritative source_post_url over listings.original_url", () => {
  assert.equal(
    resolveListingUrl({
      source: "facebook",
      sourcePostUrl: "https://www.facebook.com/groups/123/posts/456/",
      originalUrl: "https://www.facebook.com/flip-manager/manual/abc",
    }),
    "https://www.facebook.com/groups/123/posts/456/",
  );
});

test("Facebook falls back to a valid original_url when metadata is empty", () => {
  assert.equal(
    resolveListingUrl({ source: "facebook", sourcePostUrl: null, originalUrl: "https://www.facebook.com/marketplace/item/456/" }),
    "https://www.facebook.com/marketplace/item/456/",
  );
  assert.equal(
    resolveListingUrl({ source: "facebook", sourcePostUrl: null, originalUrl: "https://www.facebook.com/groups/example/permalink/1234567890/" }),
    "https://www.facebook.com/groups/example/permalink/1234567890/",
  );
});

test("Watcher and Finder resolve the same listing fixture without changing its canonical id", () => {
  const fixture = {
    listingId: "listing-123",
    source: "facebook",
    sourcePostUrl: "https://www.facebook.com/groups/123/posts/456/",
    originalUrl: null,
  };
  assert.equal(fixture.listingId, "listing-123");
  assert.equal(resolveListingUrl(fixture), fixture.sourcePostUrl);
  assert.equal(resolveListingUrl({ ...fixture, sourcePostUrl: null }), null);
});

test("manual placeholders, empty values, bad schemes, and Facebook home are rejected", () => {
  for (const input of [
    { source: "facebook", originalUrl: null },
    { source: "facebook", originalUrl: "manual:abc" },
    { source: "facebook", originalUrl: "https://www.facebook.com/flip-manager/manual/abc" },
    { source: "facebook", originalUrl: "https://www.facebook.com/" },
    { source: "facebook", originalUrl: "javascript:alert(1)" },
  ]) {
    assert.equal(resolveListingUrl(input), null, JSON.stringify(input));
  }
});

test("non-Facebook portals retain their valid HTTP(S) URL", () => {
  assert.equal(resolveListingUrl({ source: "olx", originalUrl: "https://www.olx.pl/d/oferta/mieszkanie-ID123.html" }), "https://www.olx.pl/d/oferta/mieszkanie-ID123.html");
  assert.equal(resolveListingUrl({ source: "otodom", originalUrl: "http://www.otodom.pl/pl/oferta/123" }), "http://www.otodom.pl/pl/oferta/123");
  assert.equal(resolveListingUrl({ source: "olx", originalUrl: "manual:abc" }), null);
});
