import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * HOLD-blocker integration proof: a group imported through the real
 * addWatchedFacebookGroup service must be selected by the real scheduler
 * selection logic (schedulerContext) without editing
 * FACEBOOK_PRODUCTION_SOURCES, rebuilding, or redeploying -- the database-
 * backed registry is the only runtime gate. This drives the actual
 * production functions against a controllable fake database, not a mock of
 * the selected-source list itself.
 */

const FILTER_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Automatyczny Facebook",
  sources: ["facebook"],
  is_active: true,
  scan_interval_minutes: 20,
  updated_at: "2026-09-23T00:00:00.000Z",
};

function freshDb(): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [FILTER_ROW]);
  db.seed("watched_facebook_groups", []);
  return db;
}

let currentDb = freshDb();
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });

const { addWatchedFacebookGroup, isEnabledWatchedFacebookSource } = await import("../facebook-groups/server.ts");
const { schedulerContext } = await import("./scheduler.ts");
const { enqueueFacebookJobs } = await import("./jobs.ts");

test("a group imported through the real import service is selected by the real scheduler selection logic, with no allowlist edit", async () => {
  const db = freshDb();
  currentDb = db;

  // 1. Import a new valid group through the real import service.
  const imported = await addWatchedFacebookGroup({ url: "https://www.facebook.com/groups/999888777333/", name: "Łódzka Giełda Mieszkań" });
  assert.equal(imported.success, true, "the import must succeed for a brand-new, valid group");
  if (!imported.success) return;

  // 2. It is already active/eligible through the intended workflow --
  // addWatchedFacebookGroup defaults enabled=true, exactly like the manual
  // "add group" form.
  assert.equal(imported.group.enabled, true);

  // 3. Run the real scheduler selection logic (schedulerContext), not a
  // mock of the selected-source list.
  const context = await schedulerContext(db as never, new Date("2026-09-23T12:00:00.000Z"), db as never);
  assert.ok(context, "the scheduler must find the active Facebook filter and at least one eligible source");

  // 4. Assert the group is selected for enqueue.
  const selected = context!.sources.find((source) => source.sourceId === "999888777333");
  assert.ok(selected, "the newly imported group must appear in the scheduler's selected sources");

  // 5. Assert the scheduled job would contain the imported canonical ID and URL.
  assert.equal(selected!.sourceId, "999888777333");
  assert.equal(selected!.url, "https://www.facebook.com/groups/999888777333/");
  assert.equal(selected!.name, "Łódzka Giełda Mieszkań");

  // 6. No hardcoded allowlist edit is required: this test never imports or
  // references FACEBOOK_PRODUCTION_SOURCES, and the imported group's ID
  // does not appear in that list.
});

test("an inactive (disabled) imported group is never scanned", async () => {
  const db = freshDb();
  currentDb = db;
  const imported = await addWatchedFacebookGroup({ url: "https://www.facebook.com/groups/111222333444/", name: "Disabled Test Group", enabled: false });
  assert.equal(imported.success, true);
  const context = await schedulerContext(db as never, new Date(), db as never);
  const selected = context?.sources.find((source) => source.sourceId === "111222333444");
  assert.equal(selected, undefined, "a disabled group must never be selected");
});

test("a malformed/unnormalizable group URL is never scanned", async () => {
  const db = freshDb();
  // Seed a malformed row directly (bypassing validation), simulating a
  // legacy or corrupted row -- schedulerContext must still degrade safely.
  db.seed("watched_facebook_groups", [{ id: "bad-1", name: "Broken", name_verified: true, url: "https://www.facebook.com/marketplace/item/123", city: "Łódź", priority: "normal", created_at: "2026-09-23T00:00:00.000Z", enabled: true }]);
  const context = await schedulerContext(db as never, new Date(), db as never);
  assert.equal(context, null, "with no valid source, the scheduler must find nothing to schedule (not throw, not fabricate a source)");
});

test("disabling a previously-imported group removes it from future scheduler selection", async () => {
  const db = freshDb();
  currentDb = db;
  const imported = await addWatchedFacebookGroup({ url: "https://www.facebook.com/groups/222333444555/", name: "Toggle Test Group" });
  assert.equal(imported.success, true);
  if (!imported.success) return;
  const before = await schedulerContext(db as never, new Date(), db as never);
  assert.ok(before?.sources.some((source) => source.sourceId === "222333444555"));

  const groups = db.rows("watched_facebook_groups");
  const row = groups.find((item) => item.id === imported.group.id);
  assert.ok(row);
  row!.enabled = false;

  const after = await schedulerContext(db as never, new Date(), db as never);
  const selected = after?.sources.find((source) => source.sourceId === "222333444555");
  assert.equal(selected, undefined, "disabling a group must stop future enqueue");
});

// Legacy production sources must remain scanned after the switch to the
// DB registry -- simulating the backfill migration's own seed rows.
test("a legacy production source (backfilled, name unverified) remains scanned and shows the unverified fallback name, never a bare numeric ID", async () => {
  const db = freshDb();
  db.seed("watched_facebook_groups", [
    { id: "legacy-1", name: "Nieznana grupa", name_verified: false, url: "https://www.facebook.com/groups/402796264871862/", city: "Łódź", priority: "normal", created_at: "2026-08-09T00:00:00.000Z", enabled: true },
  ]);
  const context = await schedulerContext(db as never, new Date(), db as never);
  const selected = context?.sources.find((source) => source.sourceId === "402796264871862");
  assert.ok(selected, "the legacy source must remain scanned after the registry switch");
  assert.equal(selected!.name, "Nieznana grupa");
  assert.notEqual(selected!.name, "402796264871862", "a legacy unverified row must never surface its bare numeric ID as the scheduled source's name");
});

// Profile sources (e.g. the historical 61563667387467) follow their own
// PROFILE type, never treated as a GROUP.
test("a profile source is scheduled with type=PROFILE, never misclassified as a GROUP", async () => {
  const db = freshDb();
  db.seed("watched_facebook_groups", [
    { id: "profile-1", name: "Nieznana grupa", name_verified: false, url: "https://www.facebook.com/profile.php?id=61563667387467", city: "Łódź", priority: "normal", created_at: "2026-08-09T00:00:00.000Z", enabled: true },
  ]);
  const context = await schedulerContext(db as never, new Date(), db as never);
  const selected = context?.sources.find((source) => source.sourceId === "61563667387467");
  assert.ok(selected);
  assert.equal(selected!.type, "PROFILE");
});

test("collector eligibility requires sourceId and URL to name the same registered source", async () => {
  const db = freshDb();
  currentDb = db;
  const imported = await addWatchedFacebookGroup({ url: "https://www.facebook.com/groups/333444555666/", name: "Identity Test Group" });
  assert.equal(imported.success, true);
  if (!imported.success) return;

  assert.equal(await isEnabledWatchedFacebookSource({ sourceId: "333444555666", type: "GROUP", url: "https://www.facebook.com/groups/333444555666/" }), true);
  assert.equal(await isEnabledWatchedFacebookSource({ sourceId: "333444555666", type: "GROUP", url: "https://www.facebook.com/groups/999000111222/" }), false);
  assert.equal(await isEnabledWatchedFacebookSource({ sourceId: "999000111222", type: "GROUP", url: "https://www.facebook.com/groups/333444555666/" }), false);
});

test("manual enqueue skips a malformed registry URL instead of throwing", async () => {
  const db = freshDb();
  currentDb = db;
  db.seed("watched_facebook_groups", [{ id: "bad-enqueue", name: "Broken", url: "not-a-url", enabled: true, priority: "normal", created_at: "2026-09-23T00:00:00.000Z" }]);

  const result = await enqueueFacebookJobs(FILTER_ROW as never, "run-malformed", "not-a-real-source");
  assert.deepEqual(result, { jobs: [], failedGroups: [], reasonCode: "FACEBOOK_PRODUCTION_SOURCE_NOT_CONFIGURED" });
});
