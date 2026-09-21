import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeFacebookSupabase } from "../facebook-watcher/server/facebook-fake-supabase.ts";
import type { InvestmentAlert } from "../alerts/types.ts";

function alert(overrides: Partial<InvestmentAlert> = {}): InvestmentAlert {
  return {
    id: "alert-1", eventKey: "listing-1:canonical_match:v1", type: "canonical_match", listingId: "listing-1",
    title: "Oferta", source: "facebook", sellerType: null, price: 295000, area: 47, neighborhood: "Chóralna",
    city: "Łódź", pricePerSqm: 6277, flipScore: 80, opportunityScore: 80, condition: null, groupName: null,
    flags: [], detectedAt: "2026-09-20T20:00:00Z", readAt: null, detailsUrl: "/flip-finder?listing=listing-1",
    originalUrl: null, ...overrides,
  };
}

let currentDb = new FakeFacebookSupabase();
let currentAlerts: InvestmentAlert[] = [];
let sendCount = 0;
let sendResults: Array<{ sent: number; failed: number }> = [];

const adminUrl = pathToFileURL(path.resolve(import.meta.dirname, "../facebook-watcher/supabase-admin.ts")).href;
const alertsServerUrl = pathToFileURL(path.resolve(import.meta.dirname, "../alerts/server.ts")).href;
const pushServerUrl = pathToFileURL(path.resolve(import.meta.dirname, "server.ts")).href;
mock.module(adminUrl, { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });
mock.module(alertsServerUrl, { namedExports: { getAlerts: async () => currentAlerts } });
mock.module(pushServerUrl, {
  namedExports: {
    sendPushToAll: async () => {
      const result = sendResults[sendCount] ?? sendResults[sendResults.length - 1] ?? { sent: 1, failed: 0 };
      sendCount += 1;
      return { attempted: 1, sent: result.sent, failed: result.failed };
    },
  },
});
// Real module, imported once after every dependency it uses (including its
// own module-level `delivered` in-memory cache) is fully mocked — importing
// pushTitleFor via a separate static `import` at the top of this file would
// fully evaluate alert-delivery.ts (binding the REAL admin client / alerts
// server / push transport) before mock.module() ever ran.
const { sendPendingAlertPush, pushTitleFor } = await import("./alert-delivery.ts");

test("pushTitleFor: price_drop uses the mission's exact copy", () => {
  assert.equal(pushTitleFor({ type: "price_drop", neighborhood: "Bałuty", city: null }), "📉 Spadek ceny • Bałuty");
});

test("pushTitleFor: every other alert type (including the new canonical_match) uses the opportunity copy", () => {
  for (const type of ["facebook_opportunity", "high_flip_score", "private_seller", "new_listing", "canonical_match"] as const) {
    assert.equal(pushTitleFor({ type, neighborhood: "Teofilów", city: null }), "🔥 Nowa okazja • Teofilów");
  }
});

test("pushTitleFor: falls back to city, then a generic label, when neighborhood is unknown", () => {
  assert.equal(pushTitleFor({ type: "canonical_match", neighborhood: null, city: "Łódź" }), "🔥 Nowa okazja • Łódź");
  assert.equal(pushTitleFor({ type: "canonical_match", neighborhood: null, city: null }), "🔥 Nowa okazja • Flip Manager");
});

// Task 3G: push_delivered_at must never be set unless an actual send
// succeeded, and a failed attempt must remain retryable on the next call —
// exercised against the real sendPendingAlertPush() via a fake DB and a
// mocked web-push transport, not a hand-copied reimplementation. Each test
// uses its own listingId/eventKey: sendPendingAlertPush's own module-level
// `delivered` in-memory cache is process-wide and intentionally never reset
// between calls (it is a real fast-path over the DB check), so reusing one
// eventKey across tests would leak a prior test's successful delivery into
// the next one.
function reset(alerts: InvestmentAlert[], sends: Array<{ sent: number; failed: number }>): void {
  currentDb = new FakeFacebookSupabase();
  // Every seeded row needs its own distinct id: the fake DB's update() applies
  // a matched row's payload to every row sharing its id, and every real
  // alerts row has a real id, so a batch of more than one alert here must not
  // all share the same undefined id (which every test before this file's
  // multi-alert hotfix batch happened to never exercise).
  currentDb.seed("alerts", alerts.map((item, index) => ({ id: `seed-${index}`, event_key: item.eventKey, push_delivered_at: null })));
  currentAlerts = alerts;
  sendCount = 0;
  sendResults = sends;
}

test("a successful send marks push_delivered_at exactly once, and a duplicate call does not re-send", async () => {
  reset([alert({ listingId: "listing-success", eventKey: "listing-success:canonical_match:v1" })], [{ sent: 1, failed: 0 }]);

  const first = await sendPendingAlertPush();
  assert.equal(first.sent, 1);
  assert.equal(sendCount, 1);
  const stored = currentDb.rows("alerts").find((row) => row.event_key === "listing-success:canonical_match:v1");
  assert.ok(stored?.push_delivered_at, "push_delivered_at must be set after a genuinely successful send");

  const second = await sendPendingAlertPush();
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
  assert.equal(sendCount, 1, "a second call must not send again — dedup via the persisted push_delivered_at");
});

test("a failed send never sets push_delivered_at, and the alert remains retryable on the next call", async () => {
  reset([alert({ listingId: "listing-retry", eventKey: "listing-retry:canonical_match:v1" })], [{ sent: 0, failed: 1 }, { sent: 1, failed: 0 }]);

  const first = await sendPendingAlertPush();
  assert.equal(first.sent, 0);
  assert.equal(currentDb.rows("alerts").find((row) => row.event_key === "listing-retry:canonical_match:v1")?.push_delivered_at, null, "a failed send must never mark push_delivered_at");

  const retry = await sendPendingAlertPush();
  assert.equal(retry.sent, 1, "the retry must actually attempt delivery again, not skip it");
  assert.ok(currentDb.rows("alerts").find((row) => row.event_key === "listing-retry:canonical_match:v1")?.push_delivered_at, "the successful retry must now mark push_delivered_at");
  assert.equal(sendCount, 2, "exactly two attempts total across the two calls — no unbounded retry loop within a single call");
});

test("an already-read alert is skipped without ever calling the push transport", async () => {
  reset([alert({ listingId: "listing-read", eventKey: "listing-read:canonical_match:v1", readAt: "2026-09-20T21:00:00Z" })], [{ sent: 1, failed: 0 }]);

  const result = await sendPendingAlertPush();
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(sendCount, 0);
});

// Hotfix scope A: new_listing is purely informational (no attractiveness/
// urgency signal of its own — see isPushEligibleAlertType's own comment) and
// must never reach the push transport, no matter how long it sits unread and
// undelivered. getAlerts() here is mocked directly (it already has its own
// dedicated current-listing-state coverage in features/alerts/server.test.ts),
// so this isolates exactly the type gate sendPendingAlertPush adds.
test("an ordinary new_listing alert is never sent, even when unread and undelivered", async () => {
  reset([alert({ type: "new_listing", listingId: "listing-ordinary", eventKey: "listing-ordinary:new_listing:v1" })], [{ sent: 1, failed: 0 }]);

  const result = await sendPendingAlertPush();
  assert.equal(result.sent, 0, "new_listing must never be attempted");
  assert.equal(sendCount, 0, "the push transport must never even be called for it");
  assert.equal(currentDb.rows("alerts").find((row) => row.event_key === "listing-ordinary:new_listing:v1")?.push_delivered_at, null);
});

test("canonical_match, facebook_opportunity and price_drop are push-eligible and reach the transport; new_listing in the same batch does not", async () => {
  reset(
    [
      alert({ type: "canonical_match", listingId: "listing-matched", eventKey: "listing-matched:canonical_match:v1" }),
      alert({ type: "facebook_opportunity", listingId: "listing-attractive-review", eventKey: "listing-attractive-review:facebook_opportunity:v1" }),
      alert({ type: "price_drop", listingId: "listing-price-drop", eventKey: "listing-price-drop:price_drop:v2" }),
      alert({ type: "new_listing", listingId: "listing-ordinary-2", eventKey: "listing-ordinary-2:new_listing:v1" }),
    ],
    [{ sent: 1, failed: 0 }],
  );

  const result = await sendPendingAlertPush();
  assert.equal(result.sent, 3, "the three push-eligible types must all be attempted");
  assert.equal(sendCount, 3, "the push transport is called exactly once per eligible alert, never for new_listing");
  assert.ok(currentDb.rows("alerts").find((row) => row.event_key === "listing-matched:canonical_match:v1")?.push_delivered_at);
  assert.ok(currentDb.rows("alerts").find((row) => row.event_key === "listing-attractive-review:facebook_opportunity:v1")?.push_delivered_at);
  assert.ok(currentDb.rows("alerts").find((row) => row.event_key === "listing-price-drop:price_drop:v2")?.push_delivered_at);
  assert.equal(currentDb.rows("alerts").find((row) => row.event_key === "listing-ordinary-2:new_listing:v1")?.push_delivered_at, null);
});
