import test from "node:test";
import assert from "node:assert/strict";
import { parseFacebookImageRevalidationArguments } from "./image-revalidation.ts";

test("revalidation defaults to dry-run and bounded limit", () => {
  assert.deepEqual(parseFacebookImageRevalidationArguments(["node", "index.ts", "--revalidate-images"]), { enabled: true, dryRun: true, limit: 5, listingId: null, postId: null });
  assert.equal(parseFacebookImageRevalidationArguments(["--revalidate-images", "--apply", "--limit=3", "--post-id=123"]).dryRun, false);
});

test("revalidation rejects unsafe combinations and invalid limits", () => {
  assert.throws(() => parseFacebookImageRevalidationArguments(["--revalidate-images", "--limit=0"]), /between 1 and 50/);
  assert.throws(() => parseFacebookImageRevalidationArguments(["--revalidate-images", "--listing-id=a", "--post-id=b"]), /cannot be combined/);
});
