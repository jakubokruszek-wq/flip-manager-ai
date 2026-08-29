import assert from "node:assert/strict";
import test from "node:test";
import { planFacebookGroupJobs } from "../facebook-worker/multi-group.ts";
import { findDuplicateFacebookGroup, normalizeFacebookGroupUrl, normalizeFacebookSourceUrl, parseFacebookGroupCreatePayload } from "./group-url.ts";

test("valid slug URL is canonicalized", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://facebook.com/groups/lodzsprzedazzakupwynajem"), { url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/", identifier: "lodzsprzedazzakupwynajem" });
});

test("valid numeric URL is canonicalized", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://www.facebook.com/groups/402796264871862/"), { url: "https://www.facebook.com/groups/402796264871862/", identifier: "402796264871862" });
});

test("trailing slash and missing www normalize to the same URL", () => {
  assert.equal(normalizeFacebookGroupUrl("http://facebook.com/groups/example/").url, normalizeFacebookGroupUrl("https://www.facebook.com/groups/example").url);
});

test("post URL is rejected", () => {
  assert.throws(() => normalizeFacebookGroupUrl("https://www.facebook.com/groups/example/posts/123/"), /bezpośrednio na \/groups/);
});

test("invalid domain and arbitrary Facebook paths are rejected", () => {
  assert.throws(() => normalizeFacebookGroupUrl("https://example.com/groups/test"), /facebook\.com/);
  assert.throws(() => normalizeFacebookGroupUrl("https://www.facebook.com/marketplace/item/123"), /bezpośrednio na \/groups/);
});

test("exact and alternate URL variants are controlled duplicates", () => {
  const groups = [{ url: "https://www.facebook.com/groups/example/" }];
  assert.equal(findDuplicateFacebookGroup(groups, "https://www.facebook.com/groups/example/", "example"), groups[0]);
  assert.equal(findDuplicateFacebookGroup(groups, "https://www.facebook.com/groups/example/", "EXAMPLE"), groups[0]);
});

test("empty name gets a safe identifier-based fallback", () => {
  const parsed = parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/402796264871862", name: "  " });
  assert.equal(parsed.input.name, "Facebook group 402796264871862");
  assert.equal(parsed.input.city, "Łódź");
  assert.equal(parsed.input.enabled, true);
});

test("enabled added group is included by the existing multi-group planner", () => {
  const parsed = parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/new-group", enabled: true, priority: "high" });
  const plans = planFacebookGroupJobs("filter", "run", [{ id: "new-id", name: parsed.input.name, url: parsed.input.url, priority: parsed.input.priority, createdAt: "2026-08-22T00:00:00.000Z" }]);
  assert.equal(parsed.input.enabled, true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].group.url, "https://www.facebook.com/groups/new-group/");
});

test("profile share target canonicalizes to its numeric profile URL", () => {
  assert.deepEqual(normalizeFacebookSourceUrl("https://www.facebook.com/people/Dawid-Trojanowski-VERDE-PRIME-Nieruchomości/61563667387467/", "PROFILE"), { url: "https://www.facebook.com/profile.php?id=61563667387467", identifier: "61563667387467" });
  const parsed = parseFacebookGroupCreatePayload({ type: "PROFILE", url: "https://www.facebook.com/profile.php?id=61563667387467", name: "VERDE PRIME Nieruchomości" });
  assert.equal(parsed.input.type, "PROFILE");
  assert.equal(parsed.input.sourceId, "61563667387467");
});

test("profile sources are planned without changing group sources", () => {
  const plans = planFacebookGroupJobs("filter", "run", [{ id: "profile", name: "Profile", url: "https://www.facebook.com/profile.php?id=61563667387467", type: "PROFILE", sourceId: "61563667387467", priority: "normal", createdAt: "2026-08-22T00:00:00.000Z" }]);
  assert.equal(plans[0].group.type, "PROFILE");
  assert.equal(plans[0].group.sourceId, "61563667387467");
});
