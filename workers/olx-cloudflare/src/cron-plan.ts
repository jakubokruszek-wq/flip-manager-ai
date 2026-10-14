import type { ConfigResult } from "./config.ts";

/**
 * What one Cron tick does, by mode (pure, so it is testable outside workerd):
 *  - disabled / invalid / manual: remove any alarm, claim nothing;
 *  - auto: make sure the polling alarm exists (re-arm when lost or stuck);
 *  - scheduled: arm ONE alarm that runs one scheduled claim, unless one is
 *    already pending or a batch is running (no parallel, no catch-up burst).
 */
export type CronPlan =
  | { action: "disarm"; code: string }
  | { action: "keep" }
  | { action: "arm"; atMs: number; reason: "auto_poll" | "scheduled_claim" };

export function cronPlan(loaded: ConfigResult, alarm: number | null, now: number, running: boolean): CronPlan {
  if (!loaded.ok) return { action: "disarm", code: loaded.code };
  const mode = loaded.config.claimMode;
  if (mode === "manual") return { action: "disarm", code: "OLX_CLOUD_MANUAL_MODE" };
  if (mode === "scheduled") {
    if (running || (alarm !== null && alarm >= now - 120_000)) return { action: "keep" };
    return { action: "arm", atMs: now + 1_000, reason: "scheduled_claim" };
  }
  // auto: no alarm (first start, or lost) or an alarm overdue by >2 min (stuck): run now.
  if (alarm === null || alarm < now - 120_000) return { action: "arm", atMs: now + 1_000, reason: "auto_poll" };
  return { action: "keep" };
}
