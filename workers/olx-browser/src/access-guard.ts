import type { OlxJobSummary } from "./job-runner.ts";

/** Codes produced by classifyOlxResponse when OLX refuses normal browser access. */
export const OLX_ACCESS_DENIED_CODES: ReadonlySet<string> = new Set([
  "OLX_HTTP_403",
  "OLX_HTTP_405",
  "OLX_HTTP_429",
  "OLX_HUMAN_VERIFICATION",
]);

export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

export type AccessCooldown = { reason: string; durationMs: number; until: string; level: number };

/**
 * Stops the worker from claiming further jobs after OLX refuses access (or
 * after repeated unexplained failures, which is how an IP block often looks
 * from a datacenter). The worker never tries to bypass the refusal: it only
 * waits, with a doubling pause, and then makes one normal attempt again.
 * Jobs stay queued in Supabase while the worker waits.
 */
export function createOlxAccessGuard(options: { baseCooldownMs: number; maxCooldownMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  let level = 0;
  let failureStreak = 0;
  let cooldownUntil = 0;

  function startCooldown(reason: string): AccessCooldown {
    level += 1;
    failureStreak = 0;
    const durationMs = Math.min(options.maxCooldownMs, options.baseCooldownMs * 2 ** (level - 1));
    cooldownUntil = now() + durationMs;
    return { reason, durationMs, until: new Date(cooldownUntil).toISOString(), level };
  }

  return {
    /** Returns a new cooldown when this job result requires the worker to pause. */
    record(summary: Pick<OlxJobSummary, "outcome" | "code">): AccessCooldown | null {
      if (summary.outcome === "completed") {
        level = 0;
        failureStreak = 0;
        return null;
      }
      if (summary.outcome !== "failed") return null;
      if (summary.code && OLX_ACCESS_DENIED_CODES.has(summary.code)) return startCooldown(summary.code);
      failureStreak += 1;
      if (failureStreak >= CONSECUTIVE_FAILURE_THRESHOLD) return startCooldown("CONSECUTIVE_JOB_FAILURES");
      return null;
    },
    remainingMs(): number {
      return Math.max(0, cooldownUntil - now());
    },
  };
}
