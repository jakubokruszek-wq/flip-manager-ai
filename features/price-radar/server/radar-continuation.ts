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
export async function requestRadarContinuation(input: { runId: string; hop: number }, deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const secret = env.PRICE_RADAR_CRON_SECRET;
  const origin = radarContinuationOrigin(env);
  if (!secret || !origin || input.hop < 1 || input.hop > RADAR_CONTINUATION_MAX_HOPS) return false;
  try {
    const response = await (deps.fetchImpl ?? fetch)(new URL(COLLECT_PATH, origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", [RADAR_CONTINUATION_HOP_HEADER]: String(input.hop) },
      body: JSON.stringify({ runId: input.runId }),
      cache: "no-store",
      signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
    });
    if (response.status !== 202) console.warn("RADAR_CONTINUATION_NOT_ACCEPTED", { runId: input.runId, hop: input.hop, status: response.status });
    return response.status === 202;
  } catch {
    // The lease expires on its own; the scheduler or an open PWA resumes the
    // same checkpoint later. Nothing here may throw into the caller.
    console.warn("RADAR_CONTINUATION_REQUEST_FAILED", { runId: input.runId, hop: input.hop });
    return false;
  }
}

/** Fires the next hop after the current response has been sent. */
export function scheduleRadarContinuation(input: { runId: string; hop: number }): void {
  runAfterResponse(() => requestRadarContinuation(input));
}
