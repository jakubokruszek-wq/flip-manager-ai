import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STOP_TICK = new Set(["completed", "partial", "failed", "already_ran_today", "idle", "paused_by_operator", "not_due", "automation_disabled", "user_terminated", "run_not_active"]);
const MAX_RETRY_AFTER_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 62_000;

/**
 * Drives the protected Radar collection endpoint until its durable checkpoint
 * is terminal or a hard request/time budget is reached. The endpoint owns all
 * source selection, leasing, checkpointing and OLX queue work.
 */
export async function runPriceRadarScheduler({
  url = process.env.PRICE_RADAR_COLLECT_URL,
  secret = process.env.PRICE_RADAR_CRON_SECRET,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = (message) => console.log(message),
  maxRequests = Number(process.env.MAX_REQUESTS ?? 24),
  maxElapsedMs = Number(process.env.MAX_ELAPSED_MS ?? 3_300_000),
} = {}) {
  if (typeof secret !== "string" || !secret.trim()) throw new Error("PRICE_RADAR_CRON_SECRET is not configured; no request was sent.");
  if (!url || typeof fetchImpl !== "function") throw new Error("Radar scheduler URL or fetch implementation is unavailable.");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 30) throw new Error("MAX_REQUESTS must be between 1 and 30.");
  if (!Number.isFinite(maxElapsedMs) || maxElapsedMs < 1_000 || maxElapsedMs > 3_300_000) throw new Error("MAX_ELAPSED_MS must be between 1 second and 55 minutes.");

  const startedAt = now();
  let requests = 0;
  let consecutiveFailures = 0;
  let expectedRunId = null;
  while (requests < maxRequests && now() - startedAt < maxElapsedMs) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: expectedRunId ? JSON.stringify({ runId: expectedRunId }) : "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      requests += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) throw new Error("Radar endpoint network failure after bounded retries.");
      await sleepImpl(Math.min(30_000 * consecutiveFailures, Math.max(0, maxElapsedMs - (now() - startedAt))));
      continue;
    }
    requests += 1;

    if (response.status === 401) {
      throw new Error(`Radar scheduler authorization/configuration failed (HTTP ${response.status}).`);
    }
    if (response.status === 503) {
      const unavailable = await response.clone().json().catch(() => null);
      if (typeof unavailable?.error === "string" && /CRON_SECRET/u.test(unavailable.error)) {
        throw new Error("Radar scheduler configuration is missing PRICE_RADAR_CRON_SECRET (HTTP 503).");
      }
    }
    // 409 means another worker (the server's own continuation or an open PWA)
    // changed this exact run between our read and claim. It keeps going there.
    if (response.status === 409 && expectedRunId) {
      log(`Radar tick ${requests}: run ${expectedRunId} is being continued by another worker.`);
      return { status: "run_changed", runId: expectedRunId, requests, terminal: true };
    }
    if (!response.ok) {
      consecutiveFailures += 1;
      if ((response.status >= 500 || response.status === 408 || response.status === 429) && consecutiveFailures < 3) {
        log(`Radar endpoint returned retryable HTTP ${response.status}; keeping the server checkpoint and retrying within the request limit.`);
        await sleepImpl(Math.min(30_000 * consecutiveFailures, Math.max(0, maxElapsedMs - (now() - startedAt))));
        continue;
      }
      throw new Error(`Radar endpoint failed (HTTP ${response.status}); response details were not logged.`);
    }

    let payload;
    try { payload = await response.json(); } catch { throw new Error("Radar endpoint returned invalid JSON."); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Radar endpoint returned an invalid status document.");
    consecutiveFailures = 0;
    const status = payload.status;
    const runId = typeof payload.runId === "string" ? payload.runId : "none";
    if (typeof payload.runId === "string") {
      if (expectedRunId && payload.runId !== expectedRunId) throw new Error("Radar scheduler refused to switch run IDs during checkpoint continuation.");
      expectedRunId ??= payload.runId;
    }
    if ((status === "running" || status === "waiting" || status === "waiting_for_olx") && !expectedRunId) {
      throw new Error("Radar endpoint returned unfinished work without a durable run ID.");
    }
    log(`Radar tick ${requests}: status=${String(status ?? "missing")}, run=${runId}, scanned=${Number(payload.scannedCount ?? 0)}, qualified=${Number(payload.qualifiedCount ?? 0)}.`);

    // A schedule tick with no due/enabled work is a successful no-op, not a
    // claim that the durable Radar run completed.
    if (STOP_TICK.has(status)) return { status, runId: payload.runId ?? null, requests, terminal: true };
    // OLX is deliberately the last Radar source and runs only in its existing
    // worker queue. That worker finalizes its own checkpoint; do not burn the
    // GitHub runner polling a worker that is offline.
    if (status === "waiting_for_olx") return { status, runId: payload.runId ?? null, requests, terminal: false };
    if (status !== "running" && status !== "waiting") throw new Error("Radar endpoint returned an unrecognized state; checkpoint was left untouched.");

    const suggested = Number(payload.retryAfterSeconds);
    const waitSeconds = Number.isFinite(suggested) ? Math.max(5, Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(suggested))) : 80;
    const remaining = maxElapsedMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleepImpl(Math.min(waitSeconds * 1_000, remaining));
  }

  throw new Error(`Radar scheduler reached its safe limit after ${requests} requests; the same run checkpoint remains for the next daily tick.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPriceRadarScheduler().then((result) => {
    if (!result.terminal) process.exitCode = 2;
    else if (result.status === "not_due" || result.status === "automation_disabled" || result.status === "idle") console.log(`Radar scheduler skipped this tick: status=${result.status}.`);
    else console.log(`Radar scheduler stopped at explicit run state=${result.status}.`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Radar scheduler failed.");
    process.exitCode = 1;
  });
}
