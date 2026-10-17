import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { canonicalFacebookIdentity } from "../../listing-identity.ts";
import { normalizeFacebookCollectorBatch } from "../facebook-batch.ts";
import { collectorPostsForProcessing, exactCollectorMediaCandidates } from "../facebook-batch-policy.ts";
import { preserveFacebookPublishedAt } from "../../facebook-watcher/facebook-media-binding.ts";
import { completionPayload } from "./fixtures.test-support.ts";

mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async (input: { decision: { bucket: string } }) => ({ isCurrentMatch: input.decision.bucket === "MATCHED" }) } });
mock.module("@/features/flip-finder/server/listing-ai-analysis", { namedExports: { analyzeListingWithAiIfNeeded: async () => { throw Error("AI must not be called"); } } });
mock.module("@/features/facebook-watcher/run-after-response", { namedExports: { runAfterResponse: () => undefined } });
mock.module("@/features/flip-finder/property-identity", { namedExports: { normalizeConfirmedPropertyIdentity: () => null } });
mock.module("@/features/flip-finder/olx-batch", { namedExports: { olxUrlIdToken: () => { throw Error("OLX must not execute for Facebook"); } } });
const { persistListing } = await import("../../flip-finder/server/persist-listing.ts");
const POST = "123456789012345";
function listing(patch: Record<string, unknown> = {}) {
  return { source: "facebook", externalListingId: `facebook:post:${POST}`, originalUrl: `https://www.facebook.com/groups/mock-group/posts/${POST}/`, normalizedUrl: `https://www.facebook.com/groups/mock-group/posts/${POST}/`,
    title: "Sprzedam mieszkanie", description: "Mock property", price: 300000, area: 50, pricePerSqm: 6000, rooms: 2, floor: null,
    locationText: "Mock street", city: "Łódź", district: null, images: [], thumbnailUrl: null, contentHash: "same-content", rawPayload: {}, ...patch };
}
function save(db: FakeFacebookSupabase, data = listing(), scanId = "mock-scan", decision = { bucket: "MATCHED", reasons: [] as string[], unknownFields: [] as string[] }) {
  return persistListing(db as never, "filter-mock", data as never, decision.bucket === "MATCHED", decision.unknownFields, scanId, "2026-10-15T06:00:00Z", new AbortController().signal, decision as never);
}
test("phone and Chrome normalize to the same post key and concurrent upserts create one listing", async () => {
  const phone = canonicalFacebookIdentity({ facebookPostId: POST, originalUrl: `https://m.facebook.com/groups/mock-group/posts/${POST}/?fbclid=phone` });
  const browser = canonicalFacebookIdentity({ facebookPostId: POST, originalUrl: `https://www.facebook.com/groups/other-group/posts/${POST}/` });
  assert.equal(phone.keys[0], browser.keys[0]);
  const db = new FakeFacebookSupabase();
  const [a, b] = await Promise.all([save(db, listing({ externalListingId: phone.keys[0] }), "android-scan"), save(db, listing({ externalListingId: browser.keys[0] }), "chrome-scan")]);
  assert.equal(a.listingId, b.listingId); assert.equal(db.rows("listings").length, 1);
});
test("empty Android media never removes existing photos or confirmed building attributes", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("listings", [{ id: "historical", source: "facebook", external_listing_id: `facebook:post:${POST}`, content_hash: "same-content", price: 300000, images: ["https://storage.example.invalid/verified.jpg"], building_type: "blok", ownership: "wlasnosc", first_seen_at: "2020-01-01T00:00:00Z" }]);
  await save(db); const row = db.rows("listings")[0];
  assert.deepEqual(row.images, ["https://storage.example.invalid/verified.jpg"]); assert.equal(row.building_type, "blok"); assert.equal(row.ownership, "wlasnosc"); assert.equal(row.first_seen_at, "2020-01-01T00:00:00Z");
});
test("archived historical listings stay archived and historical publication date is not replaced with scan time", async () => {
  const db = new FakeFacebookSupabase(); const old = { id: "archived", source: "facebook", external_listing_id: `facebook:post:${POST}`, lifecycle_status: "ARCHIVED", archived_at: "2020-01-01T00:00:00Z", images: ["old-photo"], price: 300000 };
  db.seed("listings", [old]); const result = await save(db);
  assert.equal(result.updated, 0); assert.deepEqual(db.rows("listings")[0], old); assert.equal(db.rows("listing_snapshots").length, 0);
  assert.equal(preserveFacebookPublishedAt(null, "2020-01-01T00:00:00Z"), "2020-01-01T00:00:00Z");
});
test("missing price remains null in a REVIEW result rather than becoming a fabricated sale price", async () => {
  const db = new FakeFacebookSupabase(); await save(db, listing({ price: null, pricePerSqm: null }), "missing-data-scan", { bucket: "REVIEW", reasons: [], unknownFields: ["price"] });
  assert.equal(db.rows("listings")[0].price, null); assert.equal(db.rows("listings")[0].lifecycle_status, "REVIEW"); assert.deepEqual(db.rows("listings")[0].missing_fields, ["price"]);
});
test("API failure at the listing write produces an error and no duplicate on a later allowed import", async () => {
  const db = new FakeFacebookSupabase(); db.failNext("listings", "upsert", "connection reset");
  await assert.rejects(save(db), /zapisać oferty/); assert.equal(db.rows("listings").length, 0);
  await save(db); assert.equal(db.rows("listings").length, 1);
});
test("API failure in history remains visible even though listing upsert already committed", async () => {
  const db = new FakeFacebookSupabase(); db.failNext("listing_snapshots", "insert", "connection reset");
  await assert.rejects(save(db), /historii oferty/); assert.equal(db.rows("listings").length, 1);
  // Completion-recovery tests cover the fence: no blind whole-import retry here.
});
test("media from a neighboring story never becomes verified, and stale capture leaves stored listing untouched", () => {
  const raw = completionPayload().batch; raw.health.capturedPostCount = 1; raw.health.visibleCardCount = 1;
  raw.posts = [{ postId: POST, permalink: `https://www.facebook.com/groups/mock-group/posts/${POST}/`, sourceId: "mock-group", sourceType: "GROUP", text: "Sprzedam mieszkanie 50 m2", author: "Mock", publishedAt: "2020-01-01T00:00:00Z", identityConfidence: "EXACT", media: [{ url: "https://scontent.xx.fbcdn.net/unrelated.jpg", exactPostId: "999999999999999", exactAssociation: true }] }];
  const batch = normalizeFacebookCollectorBatch(raw);
  assert.deepEqual(exactCollectorMediaCandidates(batch.posts[0]), []);
  assert.deepEqual(collectorPostsForProcessing(batch), []);
});
