import assert from "node:assert/strict";
import test from "node:test";
import { ensureRadarWatchdog } from "./radar-watchdog.ts";

const secret = "fixture-only-watchdog-secret";
const production = { VERCEL_ENV: "production", PRICE_RADAR_CRON_SECRET: secret };
function database(result: { data: unknown; error: unknown }, seen: unknown[]) {
  return { rpc(name: string, args: unknown) {
    seen.push({ name, args });
    return { abortSignal(signal: AbortSignal) { assert.ok(signal instanceof AbortSignal); return Promise.resolve(result); } };
  } };
}
test("only a configured production runtime can register the timer", async () => {
  const seen: unknown[] = [];
  const db = database({ data: true, error: null }, seen);
  assert.equal(await ensureRadarWatchdog(db as never, {}), false);
  assert.equal(await ensureRadarWatchdog(db as never, { ...production, VERCEL_ENV: "preview" }), false);
  assert.deepEqual(seen, []);
  assert.equal(await ensureRadarWatchdog(db as never, production), true);
  assert.deepEqual(seen, [{ name: "ensure_price_radar_watchdog", args: { p_secret: secret } }]);
});
test("a setup failure neither throws nor logs credentials or database diagnostics", async () => {
  const messages: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { messages.push(args); };
  try {
    assert.equal(await ensureRadarWatchdog(database({ data: null, error: { message: secret } }, []) as never, production), false);
    assert.deepEqual(messages, [["RADAR_WATCHDOG_SETUP_FAILED"]]);
    assert.ok(!JSON.stringify(messages).includes(secret));
  } finally { console.warn = warn; }
});
