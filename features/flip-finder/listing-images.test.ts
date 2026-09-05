import assert from "node:assert/strict";
import test from "node:test";
import { resolveListingImages } from "./listing-images.ts";

test("verified incoming media fills an existing empty gallery", () => {
  assert.deepEqual(resolveListingImages([], null, ["https://storage.example/verified.jpg"]), ["https://storage.example/verified.jpg"]);
});

test("verified incoming media is persisted for REVIEW and MATCHED alike", () => {
  const image = "https://storage.example/verified.jpg";
  assert.deepEqual(resolveListingImages([], image, [image]), [image]);
  assert.deepEqual(resolveListingImages([], image, [image]), [image]);
});

test("empty incoming media never erases an existing verified gallery", () => {
  const existing = ["https://storage.example/existing.jpg"];
  assert.deepEqual(resolveListingImages(existing, null, []), existing);
  assert.deepEqual(resolveListingImages(existing, null, undefined), existing);
});
