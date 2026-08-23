import assert from "node:assert/strict";
import test from "node:test";
import { exactBoundPropertyImages, facebookMediaBindingSummary, preserveFacebookPublishedAt } from "./facebook-media-binding.ts";
import type { FacebookListingInput } from "./types.ts";

function input(candidates: NonNullable<FacebookListingInput["mediaCandidates"]>): FacebookListingInput {
  return { mediaCandidates: candidates };
}

const exact = { url: "https://scontent.xx.fbcdn.net/a.jpg", expectedPostId: "A", boundPostId: "A", bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY" as const, rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE" as const, classificationConfidence: 0.95 };

test("exact-bound property media is accepted only for its expected post", () => {
  assert.deepEqual(exactBoundPropertyImages(input([exact]), "A"), [exact.url]);
  assert.deepEqual(exactBoundPropertyImages(input([exact]), "B"), []);
});

test("foreign and ambiguous gallery media are rejected", () => {
  const foreign = { ...exact, url: "https://scontent.xx.fbcdn.net/b.jpg", boundPostId: "B", rootStoryUnique: false, foreignPostIdsDetected: ["B"] };
  const ambiguous = { ...exact, url: "https://scontent.xx.fbcdn.net/c.jpg", boundPostId: null, bindingConfidence: 0, bindingProvenance: "AMBIGUOUS" as const, rootStoryUnique: false };
  const value = input([exact, foreign, ambiguous]);
  assert.deepEqual(exactBoundPropertyImages(value, "A"), [exact.url]);
  assert.deepEqual(facebookMediaBindingSummary(value, "A"), { candidates: 3, exactBound: 1, foreignRejected: 1, ambiguousRejected: 2 });
});

test("zero confidently bound images remains an empty safe result", () => {
  assert.deepEqual(exactBoundPropertyImages(input([]), "A"), []);
});

test("a later scan without creation time preserves published_at", () => {
  const existing = "2026-08-17T13:18:00.000Z";
  assert.equal(preserveFacebookPublishedAt(null, existing), existing);
  assert.equal(preserveFacebookPublishedAt("2026-08-17T13:18:00.000Z", null), existing);
});
