import assert from "node:assert/strict";
import test from "node:test";
import { mirrorFacebookImageUrls } from "./mirror-facebook-images-core.ts";

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const CDN_A = "https://scontent-waw2-1.xx.fbcdn.net/v/t1/a.jpg?token=one";
const CDN_B = "https://scontent.fwaw3-1.fna.fbcdn.net/v/t1/b.webp?token=two";
const STABLE = "https://project.supabase.co/storage/v1/object/public/facebook-watcher-images/facebook/listing/existing.jpg";

test("mirrors a valid Facebook JPG to a content-addressed path", async () => {
  const uploads: string[] = [];
  const result = await mirrorFacebookImageUrls("listing-1", [CDN_A], {
    fetchImpl: fetchReturning(JPG, "image/jpeg"),
    upload: async ({ path }) => { uploads.push(path); return { publicUrl: storageUrl(path), uploaded: true }; },
  });
  assert.equal(result.stats.uploadedCount, 1);
  assert.match(uploads[0], /^facebook\/listing-1\/[a-f0-9]{64}\.jpg$/);
  assert.equal(result.images[0], storageUrl(uploads[0]));
});

test("mirrors WebP and keeps source order for multiple images", async () => {
  const result = await mirrorFacebookImageUrls("listing-2", [CDN_A, CDN_B], {
    fetchImpl: async (input) => String(input).includes("b.webp") ? imageResponse(WEBP, "image/webp") : imageResponse(JPG, "image/jpeg"),
    upload: async ({ path }) => ({ publicUrl: storageUrl(path), uploaded: true }),
  });
  assert.equal(result.images.length, 2);
  assert.match(result.images[0], /\.jpg$/);
  assert.match(result.images[1], /\.webp$/);
});

test("skips HTTP 403 without failing the import", async () => {
  const result = await mirrorFacebookImageUrls("listing-3", [CDN_A], {
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.deepEqual(result.images, []);
  assert.equal(result.stats.failedCount, 1);
  assert.match(result.warnings[0], /HTTP 403/);
});

test("rejects an invalid MIME type", async () => {
  const result = await mirrorFacebookImageUrls("listing-4", [CDN_A], {
    fetchImpl: fetchReturning(new TextEncoder().encode("html"), "text/html"),
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.equal(result.stats.failedCount, 1);
  assert.deepEqual(result.images, []);
});

test("rejects an image declared above 10 MB before reading the body", async () => {
  const result = await mirrorFacebookImageUrls("listing-5", [CDN_A], {
    fetchImpl: async () => new Response(toArrayBuffer(JPG), { headers: { "content-type": "image/jpeg", "content-length": String(10 * 1024 * 1024 + 1) } }),
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.equal(result.stats.failedCount, 1);
  assert.match(result.warnings[0], /10 MB/);
});

test("does not upload duplicate content twice", async () => {
  const objects = new Map<string, string>();
  let actualUploads = 0;
  const result = await mirrorFacebookImageUrls("listing-6", [CDN_A, CDN_B], {
    fetchImpl: fetchReturning(JPG, "image/jpeg"),
    upload: async ({ path }) => {
      const existed = objects.has(path);
      if (!existed) { objects.set(path, storageUrl(path)); actualUploads += 1; }
      return { publicUrl: objects.get(path)!, uploaded: !existed };
    },
  });
  assert.equal(actualUploads, 1);
  assert.equal(result.images.length, 1);
});

test("an update preserves stable images and drops expired Facebook CDN URLs", async () => {
  const result = await mirrorFacebookImageUrls("listing-7", [], {
    existingImages: [STABLE, CDN_A],
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.deepEqual(result.images, [STABLE]);
});

test("a failed update never overwrites stable images with an empty array", async () => {
  const result = await mirrorFacebookImageUrls("listing-8", [CDN_A], {
    existingImages: [STABLE],
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.deepEqual(result.images, [STABLE]);
  assert.equal(result.stats.failedCount, 1);
});

test("exact-post replacement does not carry forward unproven existing images", async () => {
  const result = await mirrorFacebookImageUrls("post-1", [], {
    existingImages: [STABLE],
    preserveExistingImages: false,
    upload: async () => { throw new Error("upload must not run"); },
  });
  assert.deepEqual(result.images, []);
});

function fetchReturning(bytes: Uint8Array, contentType: string): typeof fetch {
  return (async () => imageResponse(bytes, contentType)) as typeof fetch;
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(toArrayBuffer(bytes), { status: 200, headers: { "content-type": contentType } });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function storageUrl(path: string): string {
  return `https://project.supabase.co/storage/v1/object/public/facebook-watcher-images/${path}`;
}
