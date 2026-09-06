import assert from "node:assert/strict";
import test from "node:test";

import { authorizeGalleryMutation } from "./gallery-request-auth.ts";

test("gallery mutation rejects requests without same-origin authorization", () => {
  const response = authorizeGalleryMutation(new Request("https://flip-manager-ai.vercel.app/api/flip-finder/listings/id/gallery", { method: "POST" }));
  assert.equal(response?.status, 403);
});

test("gallery mutation rejects cross-site origins and wrong actions", () => {
  const crossSite = authorizeGalleryMutation(new Request("https://flip-manager-ai.vercel.app/api/flip-finder/listings/id/gallery", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-flip-finder-action": "gallery" } }));
  assert.equal(crossSite?.status, 403);
  const wrongAction = authorizeGalleryMutation(new Request("https://flip-manager-ai.vercel.app/api/flip-finder/listings/id/gallery", { method: "POST", headers: { origin: "https://flip-manager-ai.vercel.app", "sec-fetch-site": "same-origin", "x-flip-finder-action": "other" } }));
  assert.equal(wrongAction?.status, 403);
});

test("canonical Finder mutation is authorized", () => {
  const response = authorizeGalleryMutation(new Request("https://flip-manager-ai.vercel.app/api/flip-finder/listings/id/gallery", { method: "POST", headers: { origin: "https://flip-manager-ai.vercel.app", "sec-fetch-site": "same-origin", "x-flip-finder-action": "gallery" } }));
  assert.equal(response, null);
});
