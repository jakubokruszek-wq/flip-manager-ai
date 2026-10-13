import "server-only";

import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";

/**
 * Server-side self-continuation of one exact Radar run.
 *
 * GitHub Actions' `schedule` trigger was confirmed (2026-10-13) to deliver the
 * "every 5 minutes" Radar workflow once in a whole day, and the PWA stops
 * driving the run as soon as the phone sleeps. So after every portion that
 * leaves the run "running", the server itself asks the protected collect
 * endpoint for the next portion of the same run ID. The endpoint acknowledges
 * with 202 immediately and does the portion after the response, so each hop
 * stays inside one function's time budget. Concurrency is still owned by the
 * run's fenced lease: a hop that loses the CAS simply ends, and no hop can
 * ever create a run (it only continues the run ID it was given).
 */
export const RADAR_CONTINUATION_HOP_HEADER = "x-radar-continuation-hop";
/** Marks an owner tick from Supabase pg_cron that must be acknowledged at once. */
export const RADAR_WATCHDOG_HEADER = "x-radar-watchdog";
/** ~45s per portion: bounds one chain to a few hours even if a run never finishes. */
export const RADAR_CONTINUATION_MAX_HOPS = 300;
const COLLECT_PATH = "/api/jobs/price-radar-collect";
const ACK_TIMEOUT_MS = 8_000;
const DEFAULT_PRODUCTION_HOST = "flip-manager-ai.vercel.app";

/**
 * Only a configured origin is ever used: deriving it from the incoming
 * request's Host header could send the secret to a caller-chosen host.
 * Preview/local deployments do not chain unless explicitly configured.
 */
export function radarContinuationOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PRICE_RADAR_CONTINUATION_ORIGIN?.trim();
  if (configured) {
    try { return new URL(configured).origin; } catch { return null; }
  }
  if (env.VERCEL_ENV !== "production") return null;
  const host = env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || DEFAULT_PRODUCTION_HOST;
  return `https://${host.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "")}`;
}

export function parseRadarContinuationHop(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,4}$/u.test(value)) return null;
  const hop = Number(value);
  return hop >= 1 && hop <= RADAR_CONTINUATION_MAX_HOPS ? hop : null;
}

/** Sends one hop and waits only for the endpoint's 202 acknowledgement. */
export async function requestRadarContinuation(input: { runId: string; hop: number }, deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<boolean> {
  return (await sendRadarContinuation(input, deps)).ok;
}

type ContinuationAttempt = { ok: true } | { ok: false; reason: string };

async function sendRadarContinuation(input: { runId: string; hop: number }, deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ContinuationAttempt> {
  const env = deps.env ?? process.env;
  const secret = env.PRICE_RADAR_CRON_SECRET;
  const origin = radarContinuationOrigin(env);
  if (!secret) return { ok: false, reason: "PRICE_RADAR_CRON_SECRET_MISSING" };
  if (!origin) return { ok: false, reason: "CONTINUATION_ORIGIN_NOT_CONFIGURED" };
  if (input.hop < 1 || input.hop > RADAR_CONTINUATION_MAX_HOPS) return { ok: false, reason: "CONTINUATION_HOP_LIMIT" };
  try {
    const response = await (deps.fetchImpl ?? fetch)(new URL(COLLECT_PATH, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", [RADAR_CONTINUATION_HOP_HEADER]: String(input.hop) },
      body: JSON.stringify({ runId: input.runId }),
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(ACK_TIMEOUT_MS, deps.timeoutMs ?? ACK_TIMEOUT_MS))),
    });
    if (response.status === 202) return { ok: true };
    console.warn("RADAR_CONTINUATION_NOT_ACCEPTED", { runId: input.runId, hop: input.hop, status: response.status });
    return { ok: false, reason: `HTTP_${response.status}` };
  } catch (error) {
    // The lease expires on its own; the watchdog, scheduler or an open PWA
    // resumes the same checkpoint later. Nothing here may throw.
    console.warn("RADAR_CONTINUATION_REQUEST_FAILED", { runId: input.runId, hop: input.hop });
    return { ok: false, reason: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "ACK_TIMEOUT" : "NETWORK_ERROR" };
  }
}

/** Longest Retry-After the chain waits out itself; longer waits are left to the watchdog. */
export const RADAR_CONTINUATION_MAX_RETRY_WAIT_MS = 300_000;
const MIN_ACK_WINDOW_MS = 3_000;

export type RadarContinuationOutcome = { requested: boolean; reason?: string };

/**
 * Hands the run to the next hop once this portion is done. It waits out a
 * short Retry-After first (inside this function's own time budget, so the
 * portal is not asked again early and hops are not burnt), retries a failed
 * hand-off once, and reports a final failure so it can be stored in the
 * run's diagnostics. It never throws.
 */
export async function continueRadarAfterPortion(
  input: { runId: string; hop: number; deadlineAt: number; waitingUntil?: string | null },
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; now?: () => number; onFailure?: (reason: string) => Promise<void> } = {},
): Promise<RadarContinuationOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fail = async (reason: string): Promise<RadarContinuationOutcome> => {
    try { await deps.onFailure?.(reason); } catch { /* diagnostics only */ }
    return { requested: false, reason };
  };
  const waitUntil = input.waitingUntil ? Date.parse(input.waitingUntil) : Number.NaN;
  if (Number.isFinite(waitUntil) && waitUntil > now()) {
    if (waitUntil - now() > RADAR_CONTINUATION_MAX_RETRY_WAIT_MS) return fail("RETRY_AFTER_LEFT_TO_WATCHDOG");
    const wait = Math.min(waitUntil - now(), input.deadlineAt - now() - MIN_ACK_WINDOW_MS * 2);
    if (wait > 0) await sleep(wait);
  }
  let last: ContinuationAttempt = { ok: false, reason: "NO_TIME_LEFT" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = input.deadlineAt - now();
    if (remaining < MIN_ACK_WINDOW_MS && attempt > 0) break;
    last = await sendRadarContinuation({ runId: input.runId, hop: input.hop }, { fetchImpl: deps.fetchImpl, env: deps.env, timeoutMs: Math.max(MIN_ACK_WINDOW_MS, remaining) });
    if (last.ok) return { requested: true };
    if (last.reason === "PRICE_RADAR_CRON_SECRET_MISSING" || last.reason === "CONTINUATION_ORIGIN_NOT_CONFIGURED" || last.reason === "CONTINUATION_HOP_LIMIT") break;
    if (attempt === 0 && input.deadlineAt - now() > MIN_ACK_WINDOW_MS + 1_000) await sleep(1_000);
  }
  return fail(last.reason);
}

/** Fires the next hop after the current response has been sent. */
export function scheduleRadarContinuation(input: Parameters<typeof continueRadarAfterPortion>[0], deps: Parameters<typeof continueRadarAfterPortion>[1] = {}): void {
  runAfterResponse(() => continueRadarAfterPortion(input, deps));
}
