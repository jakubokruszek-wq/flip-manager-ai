import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { runAndroidDataOnlyImport } from "./import-policy.ts";
let visionCalls = 0;
mock.module("@/features/facebook-watcher/analyze-facebook-images", { namedExports: { analyzeFacebookImages: async () => { visionCalls++; return null; } } });
const { extractFacebookListing } = await import("../../facebook-watcher/extract-facebook-listing.ts");
test("data-only extraction cannot call paid Vision even with incomplete data and images", async () => {
  visionCalls=0;
  await runAndroidDataOnlyImport(() => extractFacebookListing({ postText: "Sprzedam mieszkanie", images: ["https://synthetic.invalid/photo.jpg"] }));
  assert.equal(visionCalls,0);
});
test("Android policy does not disable the existing browser extraction path", async () => {
  visionCalls=0;
  await extractFacebookListing({ postText: "Sprzedam mieszkanie", images: ["https://synthetic.invalid/photo.jpg"] });
  assert.equal(visionCalls,1);
});
