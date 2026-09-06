import assert from "node:assert/strict";
import test from "node:test";

import { dataFirstFacebookImageResult } from "./facebook-image-mode.ts";

test("SEARCH_DATA_FIRST keeps stable stored images without downloading media", () => {
  const result = dataFirstFacebookImageResult(
    [
      "https://storage.example.com/listings/a.jpg",
      "https://scontent.xx.fbcdn.net/old-facebook-cdn.jpg",
      "https://storage.example.com/listings/a.jpg",
    ],
    3,
  );

  assert.deepEqual(result.images, ["https://storage.example.com/listings/a.jpg"]);
  assert.deepEqual(result.stats, {
    inputCount: 3,
    uploadedCount: 0,
    skippedCount: 3,
    failedCount: 0,
  });
  assert.deepEqual(result.warnings, []);
});

test("SEARCH_DATA_FIRST handles an offer without exact media", () => {
  const result = dataFirstFacebookImageResult([], 0);

  assert.deepEqual(result.images, []);
  assert.equal(result.stats.inputCount, 0);
  assert.equal(result.stats.uploadedCount, 0);
  assert.equal(result.stats.failedCount, 0);
});
