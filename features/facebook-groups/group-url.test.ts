import assert from "node:assert/strict";
import test from "node:test";
import { planFacebookGroupJobs } from "../facebook-worker/multi-group.ts";
import { FacebookGroupValidationError, findDuplicateFacebookGroup, normalizeFacebookGroupUrl, normalizeFacebookSourceUrl, parseFacebookGroupCreatePayload } from "./group-url.ts";

test("valid slug URL is canonicalized", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://facebook.com/groups/lodzsprzedazzakupwynajem"), { url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/", identifier: "lodzsprzedazzakupwynajem" });
});

test("valid numeric URL is canonicalized", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://www.facebook.com/groups/402796264871862/"), { url: "https://www.facebook.com/groups/402796264871862/", identifier: "402796264871862" });
});

test("trailing slash and missing www normalize to the same URL", () => {
  assert.equal(normalizeFacebookGroupUrl("http://facebook.com/groups/example/").url, normalizeFacebookGroupUrl("https://www.facebook.com/groups/example").url);
});

test("mobile Facebook group URLs with query strings and fragments normalize to the desktop root", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://m.facebook.com/groups/MobileGroup/?ref=bookmarks#recent"), { url: "https://www.facebook.com/groups/MobileGroup/", identifier: "mobilegroup" });
});

test("Facebook group URLs containing URL userinfo are rejected", () => {
  for (const value of [
    "https://user@facebook.com/groups/example",
    "https://user:pass@facebook.com/groups/example",
    "https://user%40name:pass%40word@facebook.com/groups/example",
  ]) assert.throws(() => normalizeFacebookGroupUrl(value), /credentials/);
});

test("at-signs in a group query do not create URL userinfo", () => {
  assert.deepEqual(normalizeFacebookGroupUrl("https://m.facebook.com/groups/example?mention=user@example.com"), { url: "https://www.facebook.com/groups/example/", identifier: "example" });
});

test("post URL is rejected", () => {
  assert.throws(() => normalizeFacebookGroupUrl("https://www.facebook.com/groups/example/posts/123/"), /bezpośrednio na \/groups/);
});

test("invalid domain and arbitrary Facebook paths are rejected", () => {
  assert.throws(() => normalizeFacebookGroupUrl("https://example.com/groups/test"), /facebook\.com/);
  assert.throws(() => normalizeFacebookGroupUrl("https://m.facebook.com.example.org/groups/test"), /facebook\.com/);
  assert.throws(() => normalizeFacebookGroupUrl("https://www.facebook.com/marketplace/item/123"), /bezpośrednio na \/groups/);
});

test("exact and alternate URL variants are controlled duplicates", () => {
  const groups = [{ url: "https://www.facebook.com/groups/example/" }];
  assert.deepEqual(findDuplicateFacebookGroup(groups, "https://www.facebook.com/groups/example/", "example"), { kind: "watched-group", group: groups[0] });
  assert.deepEqual(findDuplicateFacebookGroup(groups, "https://www.facebook.com/groups/example/", "EXAMPLE"), { kind: "watched-group", group: groups[0] });
});

// HOLD-blocker requirement: a group identifier already approved in
// FACEBOOK_PRODUCTION_SOURCES (features/collector/facebook-production.ts)
// must be detected as a duplicate even when it has no matching
// watched_facebook_groups row at all — these are two genuinely separate
// registries (see findDuplicateFacebookGroup's own doc comment).
test("a URL matching an approved production source (with no watched-group row at all) is a production-source duplicate", () => {
  const productionSources = [{ sourceId: "402796264871862", sourceUrl: "https://www.facebook.com/groups/402796264871862/", sourceType: "GROUP" as const }];
  const result = findDuplicateFacebookGroup([], "https://www.facebook.com/groups/402796264871862/", "402796264871862", productionSources);
  assert.deepEqual(result, { kind: "production-source", source: productionSources[0] });
});

test("a watched-group match takes priority over a production-source match when both exist", () => {
  const groups = [{ url: "https://www.facebook.com/groups/402796264871862/", canonicalGroupId: "402796264871862" }];
  const productionSources = [{ sourceId: "402796264871862", sourceUrl: "https://www.facebook.com/groups/402796264871862/", sourceType: "GROUP" as const }];
  const result = findDuplicateFacebookGroup(groups, "https://www.facebook.com/groups/402796264871862/", "402796264871862", productionSources);
  assert.deepEqual(result, { kind: "watched-group", group: groups[0] });
});

// HOLD-blocker requirement: no bare numeric-ID synthetic name. A group name
// is now required at creation time, exactly like it already was at edit
// time (management.ts's requiredText) — never silently defaulted.
test("an empty or missing name is rejected — a real group name is required, never a numeric-ID synthetic fallback", () => {
  assert.throws(() => parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/402796264871862", name: "  " }), FacebookGroupValidationError);
  assert.throws(() => parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/402796264871862" }), /Nazwa grupy jest wymagana/);
});

test("a supplied name is preserved verbatim, never replaced by the identifier", () => {
  const parsed = parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/402796264871862", name: "Łódzkie Nieruchomości Flip" });
  assert.equal(parsed.input.name, "Łódzkie Nieruchomości Flip");
  assert.equal(parsed.input.city, "Łódź");
  assert.equal(parsed.input.enabled, true);
});

test("enabled added group is included by the existing multi-group planner", () => {
  const parsed = parseFacebookGroupCreatePayload({ url: "https://facebook.com/groups/new-group", name: "Nowa Grupa Testowa", enabled: true, priority: "high" });
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

test("profile URLs containing URL userinfo are rejected", () => {
  assert.throws(() => normalizeFacebookSourceUrl("https://user:pass@www.facebook.com/profile.php?id=61563667387467", "PROFILE"), /credentials/);
});

test("profile sources are planned without changing group sources", () => {
  const plans = planFacebookGroupJobs("filter", "run", [{ id: "profile", name: "Profile", url: "https://www.facebook.com/profile.php?id=61563667387467", type: "PROFILE", sourceId: "61563667387467", priority: "normal", createdAt: "2026-08-22T00:00:00.000Z" }]);
  assert.equal(plans[0].group.type, "PROFILE");
  assert.equal(plans[0].group.sourceId, "61563667387467");
});
