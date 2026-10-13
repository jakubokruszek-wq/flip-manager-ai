import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("@/features/facebook-watcher/run-after-response", { namedExports: { runAfterResponse: () => { throw new Error("not used in these tests"); } } });
const { continueRadarAfterPortion, RADAR_CONTINUATION_MAX_RETRY_WAIT_MS, parseRadarContinuationHop, radarContinuationOrigin, requestRadarContinuation, RADAR_CONTINUATION_HOP_HEADER, RADAR_CONTINUATION_MAX_HOPS } = await import("./radar-continuation.ts");

const RUN_ID = "97183d20-ae89-4e59-b970-8271be828921";

test("the continuation origin is configuration-only, never derived from a request Host header", () => {
  assert.equal(radarContinuationOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "flip-manager-ai.vercel.app" } as unknown as NodeJS.ProcessEnv), "https://flip-manager-ai.vercel.app");
  assert.equal(radarContinuationOrigin({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), "https://flip-manager-ai.vercel.app");
  assert.equal(radarContinuationOrigin({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "flip-manager-ai.vercel.app" } as unknown as NodeJS.ProcessEnv), null, "previews never chain into Production");
  assert.equal(radarContinuationOrigin({} as unknown as NodeJS.ProcessEnv), null);
  assert.equal(radarContinuationOrigin({ PRICE_RADAR_CONTINUATION_ORIGIN: "http://127.0.0.1:3000/ignored" } as unknown as NodeJS.ProcessEnv), "http://127.0.0.1:3000");
});

test("hop numbers are bounded so a chain can never run away", () => {
  assert.equal(parseRadarContinuationHop("1"), 1);
  assert.equal(parseRadarContinuationHop(String(RADAR_CONTINUATION_MAX_HOPS)), RADAR_CONTINUATION_MAX_HOPS);
  for (const invalid of [null, "", "0", "-1", "1.5", "abc", String(RADAR_CONTINUATION_MAX_HOPS + 1), "99999"]) assert.equal(parseRadarContinuationHop(invalid), null, String(invalid));
});

test("a hop sends only the exact run ID with the Radar-only secret and waits for the 202 acknowledgement", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ status: "accepted" }), { status: 202 }); }) as unknown as typeof fetch;
  const ok = await requestRadarContinuation({ runId: RUN_ID, hop: 3 }, { fetchImpl, env: { VERCEL_ENV: "production", PRICE_RADAR_CRON_SECRET: "radar-secret" } as unknown as NodeJS.ProcessEnv });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://flip-manager-ai.vercel.app/api/jobs/price-radar-collect");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer radar-secret");
  assert.equal(headers[RADAR_CONTINUATION_HOP_HEADER], "3");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { runId: RUN_ID });
});

test("a missing secret, a non-production deployment, a network failure or the hop limit never throws into the portion", async () => {
  let calls = 0;
  const failing = (async () => { calls += 1; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const production = { VERCEL_ENV: "production", PRICE_RADAR_CRON_SECRET: "radar-secret" } as unknown as NodeJS.ProcessEnv;
  assert.equal(await requestRadarContinuation({ runId: RUN_ID, hop: 1 }, { fetchImpl: failing, env: { VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv }), false);
  assert.equal(await requestRadarContinuation({ runId: RUN_ID, hop: 1 }, { fetchImpl: failing, env: { PRICE_RADAR_CRON_SECRET: "radar-secret" } as unknown as NodeJS.ProcessEnv }), false);
  assert.equal(await requestRadarContinuation({ runId: RUN_ID, hop: RADAR_CONTINUATION_MAX_HOPS + 1 }, { fetchImpl: failing, env: production }), false);
  assert.equal(calls, 0);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await requestRadarContinuation({ runId: RUN_ID, hop: 1 }, { fetchImpl: failing, env: production }), false);
  } finally { warn.mock.restore(); }
  assert.equal(calls, 1);
});

const PRODUCTION_ENV = { VERCEL_ENV: "production", PRICE_RADAR_CRON_SECRET: "radar-secret" } as unknown as NodeJS.ProcessEnv;
function fakeClock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, sleeps };
}

test("a short Retry-After is waited out before the next hop, within this function's own deadline", async () => {
  const clock = fakeClock();
  const requests: number[] = [];
  const fetchImpl = (async () => { requests.push(clock.now()); return new Response("{}", { status: 202 }); }) as unknown as typeof fetch;
  const outcome = await continueRadarAfterPortion({ runId: RUN_ID, hop: 2, deadlineAt: clock.now() + 40_000, waitingUntil: new Date(clock.now() + 20_000).toISOString() }, { fetchImpl, env: PRODUCTION_ENV, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(outcome, { requested: true });
  assert.deepEqual(clock.sleeps, [20_000]);
  assert.equal(requests[0], 1_000_000 + 20_000, "the next portion is not requested before Retry-After");
});

test("a long Retry-After is left to the watchdog instead of burning hops, and the reason is recorded", async () => {
  const clock = fakeClock();
  const failures: string[] = [];
  let requests = 0;
  const fetchImpl = (async () => { requests += 1; return new Response("{}", { status: 202 }); }) as unknown as typeof fetch;
  const outcome = await continueRadarAfterPortion({ runId: RUN_ID, hop: 2, deadlineAt: clock.now() + 40_000, waitingUntil: new Date(clock.now() + RADAR_CONTINUATION_MAX_RETRY_WAIT_MS + 1_000).toISOString() }, { fetchImpl, env: PRODUCTION_ENV, now: clock.now, sleep: clock.sleep, onFailure: async (reason) => { failures.push(reason); } });
  assert.equal(outcome.requested, false);
  assert.equal(requests, 0);
  assert.deepEqual(failures, ["RETRY_AFTER_LEFT_TO_WATCHDOG"]);
});

test("a failed hand-off is retried once and then reported, never thrown", async () => {
  const clock = fakeClock();
  const failures: string[] = [];
  let attempts = 0;
  const fetchImpl = (async () => { attempts += 1; return new Response("{}", { status: 503 }); }) as unknown as typeof fetch;
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const outcome = await continueRadarAfterPortion({ runId: RUN_ID, hop: 7, deadlineAt: clock.now() + 20_000 }, { fetchImpl, env: PRODUCTION_ENV, now: clock.now, sleep: clock.sleep, onFailure: async (reason) => { failures.push(reason); } });
    assert.deepEqual(outcome, { requested: false, reason: "HTTP_503" });
  } finally { warn.mock.restore(); }
  assert.equal(attempts, 2);
  assert.deepEqual(failures, ["HTTP_503"]);

  let recovered = 0;
  const flaky = (async () => { recovered += 1; return new Response("{}", { status: recovered === 1 ? 502 : 202 }); }) as unknown as typeof fetch;
  const warn2 = mock.method(console, "warn", () => undefined);
  try {
    assert.deepEqual(await continueRadarAfterPortion({ runId: RUN_ID, hop: 8, deadlineAt: clock.now() + 20_000 }, { fetchImpl: flaky, env: PRODUCTION_ENV, now: clock.now, sleep: clock.sleep }), { requested: true });
  } finally { warn2.mock.restore(); }
});
