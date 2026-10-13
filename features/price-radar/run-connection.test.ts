import assert from "node:assert/strict";
import test from "node:test";
import { describeRadarRequestError, RadarHttpError, radarConnectionIssue, radarLeaseExpiredForBrowserResume, radarRunPollDelayMs, RADAR_BROWSER_RESUME_GRACE_MS } from "./run-connection.ts";

test("the browser's raw 'Failed to fetch' is never shown; offline and unreachable server are told apart", () => {
  const failed = new TypeError("Failed to fetch");
  assert.equal(radarConnectionIssue(failed, false), "offline");
  assert.equal(radarConnectionIssue(failed, true), "network");
  assert.equal(radarConnectionIssue(new TypeError("Load failed"), true), "network", "Safari/iOS PWA wording");
  assert.equal(radarConnectionIssue(new TypeError("NetworkError when attempting to fetch resource."), true), "network");
  for (const online of [true, false]) {
    const message = describeRadarRequestError(failed, "fallback", online);
    assert.doesNotMatch(message, /failed to fetch/iu);
    assert.match(message, online ? /połączyć z serwerem/u : /Brak połączenia z internetem/u);
  }
});

test("server errors are distinguished from a lost connection and keep the saved progress message", () => {
  assert.equal(radarConnectionIssue(new RadarHttpError(503, "x"), true), "server");
  assert.equal(radarConnectionIssue(new RadarHttpError(500, "x"), false), "server", "an HTTP answer proves the network works");
  assert.equal(radarConnectionIssue(new RadarHttpError(401, "x"), true), "session");
  assert.match(describeRadarRequestError(new RadarHttpError(502, "raw"), "fallback", true), /Serwer Radaru chwilowo nie odpowiada/u);
  assert.equal(describeRadarRequestError(new RadarHttpError(400, "Czytelny komunikat serwera"), "fallback", true), "Czytelny komunikat serwera");
  assert.equal(describeRadarRequestError("not-an-error", "Zapasowy komunikat", true), "Zapasowy komunikat");
});

test("polling continues after a run finishes and backs off, without ever stopping, after failures", () => {
  assert.equal(radarRunPollDelayMs({ nonterminal: true, consecutiveFailures: 0 }), 5_000);
  const idle = radarRunPollDelayMs({ nonterminal: false, consecutiveFailures: 0 });
  assert.ok(idle >= 30_000 && idle <= 60_000, "a finished run is still refreshed every 30-60 s");
  const delays = [1, 2, 3, 4, 10].map((consecutiveFailures) => radarRunPollDelayMs({ nonterminal: true, consecutiveFailures }));
  assert.deepEqual(delays, [15_000, 30_000, 60_000, 60_000, 60_000]);
});

test("the PWA leaves a freshly released lease to the server's own continuation", () => {
  const now = Date.parse("2026-10-13T06:20:00.000Z");
  assert.equal(radarLeaseExpiredForBrowserResume(new Date(now - 1_000).toISOString(), now), false);
  assert.equal(radarLeaseExpiredForBrowserResume(new Date(now - RADAR_BROWSER_RESUME_GRACE_MS).toISOString(), now), true);
  assert.equal(radarLeaseExpiredForBrowserResume("2026-10-13T06:19:19.000Z", Date.parse("2026-10-13T06:21:00.000Z")), true, "the Production stall (lease expired 08:19:19 Warsaw) is resumed");
  assert.equal(radarLeaseExpiredForBrowserResume(null, now), true);
  assert.equal(radarLeaseExpiredForBrowserResume("garbage", now), true);
});
