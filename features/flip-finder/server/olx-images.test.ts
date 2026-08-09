import assert from "node:assert/strict";
import test from "node:test";

import { extractOlxImages } from "./olx-images";

test("extracts a single OLX image", () => {
  assert.deepEqual(extractOlxImages(["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000"]), ["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000"]);
});

test("keeps several OLX images in source order", () => {
  assert.deepEqual(extractOlxImages(["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000", "https://ireland.apollo.olxcdn.com/v1/files/two/image;s=750x1000"]), ["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000", "https://ireland.apollo.olxcdn.com/v1/files/two/image;s=750x1000"]);
});

test("prefers the largest srcset variant", () => {
  assert.deepEqual(extractOlxImages([{ srcset: "https://ireland.apollo.olxcdn.com/v1/files/one/image;s=300x400 300w, https://ireland.apollo.olxcdn.com/v1/files/one/image;s=1200x1600 1200w" }]), ["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=1200x1600"]);
});

test("removes duplicate URLs", () => {
  assert.deepEqual(extractOlxImages(["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000", "https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000"]), ["https://ireland.apollo.olxcdn.com/v1/files/one/image;s=750x1000"]);
});

test("returns no image for absent or placeholder values", () => {
  assert.deepEqual(extractOlxImages(null), []);
  assert.deepEqual(extractOlxImages(["https://ireland.apollo.olxcdn.com/static/placeholder.png", "not-a-url"]), []);
});
