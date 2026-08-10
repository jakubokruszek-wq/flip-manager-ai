import assert from "node:assert/strict";
import test from "node:test";

import { assertAllowedOlxUrl, isOlxChallengeHtml, parseOlxHtml } from "./olx-parser.ts";

test("normalizes a minimal PRERENDERED_STATE fixture without storing an OLX page", () => {
  const state = { listing: { listing: { ads: [{
    id: "example-ID123.html",
    url: "https://www.olx.pl/d/oferta/example-ID123.html",
    title: "Mieszkanie Łódź",
    price: { regularPrice: { value: 300000 } },
    params: [{ key: "m", normalizedValue: "50" }, { key: "rooms", normalizedValue: "two" }],
    location: { cityName: "Łódź", districtName: "Bałuty" },
    photos: [],
  }] } } };
  const html = `<script>window.__PRERENDERED_STATE__ = ${JSON.stringify(JSON.stringify(state))};</script>`;
  const result = parseOlxHtml(html);
  assert.equal(result.rawItems, 1);
  assert.equal(result.normalizedItems, 1);
  assert.equal(result.listings[0]?.area, 50);
  assert.equal(result.listings[0]?.rooms, 2);
});

test("detects Human Verification and rejects arbitrary hosts", () => {
  assert.equal(isOlxChallengeHtml("<title>Human Verification</title>"), true);
  assert.throws(() => assertAllowedOlxUrl("https://example.com/listings"), /OLX_URL_NOT_ALLOWED/);
});
