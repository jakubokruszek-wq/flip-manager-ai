import assert from "node:assert/strict";
import test from "node:test";

import { assertAllowedOlxUrl, isOlxChallengeHtml, parseOlxHtml } from "./olx-parser.ts";

function prerenderedHtml(state: unknown): string {
  return `<script>window.__PRERENDERED_STATE__ = ${JSON.stringify(JSON.stringify(state))};</script>`;
}

test("normalizes a minimal PRERENDERED_STATE fixture without storing an OLX page", () => {
  const state = { listing: { listing: { ads: [{
    id: "example-ID123.html",
    url: "https://www.olx.pl/d/oferta/example-ID123.html",
    title: "Mieszkanie Łódź",
    price: { regularPrice: { value: 300000 } },
    params: [{ key: "m", normalizedValue: "50" }, { key: "rooms", normalizedValue: "two" }],
    location: { cityName: "Łódź", districtName: "Bałuty" },
    photos: [],
    createdTime: "2026-08-22T18:00:00Z",
  }] } } };
  const result = parseOlxHtml(prerenderedHtml(state));
  assert.equal(result.rawItems, 1);
  assert.equal(result.normalizedItems, 1);
  assert.equal(result.listings[0]?.area, 50);
  assert.equal(result.listings[0]?.rooms, 2);
  assert.equal(result.listings[0]?.publishedAt, "2026-08-22T18:00:00.000Z");
});

test("accepts an empty ads array as a normal empty result", () => {
  const result = parseOlxHtml(prerenderedHtml({ listing: { listing: { ads: [] } } }));
  assert.equal(result.rawItems, 0);
  assert.equal(result.normalizedItems, 0);
  assert.deepEqual(result.warnings, ["OLX zwrócił pustą listę ofert."]);
});

test("reports a missing ads path as a parser shape change", () => {
  assert.throws(
    () => parseOlxHtml(prerenderedHtml({ listing: {} })),
    { message: "OLX_PARSER_SHAPE_CHANGED" },
  );
});

test("reports a changed ads shape instead of an empty result", () => {
  assert.throws(
    () => parseOlxHtml(prerenderedHtml({ listing: { listing: { ads: { items: [] }, items: [] } } })),
    { message: "OLX_PARSER_SHAPE_CHANGED" },
  );
});

test("detects Human Verification and rejects arbitrary hosts", () => {
  assert.equal(isOlxChallengeHtml("<title>Human Verification</title>"), true);
  assert.throws(() => assertAllowedOlxUrl("https://example.com/listings"), /OLX_URL_NOT_ALLOWED/);
});
