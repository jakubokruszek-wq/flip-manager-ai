export type SchedulerSource = {
  watchedSourceId: string;
  sourceId: string;
  name: string;
  url: string;
  type: "GROUP" | "PROFILE";
  priority: "high" | "normal" | "low";
  createdAt: string;
};

const PRIORITY = { high: 0, normal: 1, low: 2 } as const;

export function orderSchedulerSources(sources: SchedulerSource[]): SchedulerSource[] {
  return [...sources].sort((left, right) => PRIORITY[left.priority] - PRIORITY[right.priority]
    || left.createdAt.localeCompare(right.createdAt)
    || left.sourceId.localeCompare(right.sourceId));
}

export function nextSchedulerSource(
  plan: SchedulerSource[],
  completedSourceIds: string[],
  failedSourceIds: string[],
): SchedulerSource | null {
  const terminal = new Set([...completedSourceIds, ...failedSourceIds]);
  return plan.find((source) => !terminal.has(source.sourceId)) ?? null;
}

export function schedulerCooldownMinutes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(60, Math.min(value, 24 * 60)) : 24 * 60;
}

export function isStaleAt(value: unknown, timeoutMs: number, nowMs = Date.now()): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && nowMs - Date.parse(value) > timeoutMs;
}

export type ActiveJobDecision = "WAIT" | "FAIL_NEVER_CLAIMED" | "FAIL_NO_PROGRESS" | "RECONCILE_TERMINAL";

export function activeJobDecision(job: { status: string; attempts: number; createdAt: string | null; heartbeatAt: string | null }, nowMs = Date.now()): ActiveJobDecision {
  if (job.status === "queued" && job.attempts === 0 && isStaleAt(job.createdAt, 90_000, nowMs)) return "FAIL_NEVER_CLAIMED";
  if (job.status === "running" && isStaleAt(job.heartbeatAt, 8 * 60_000, nowMs)) return "FAIL_NO_PROGRESS";
  if (job.status === "queued" || job.status === "running") return "WAIT";
  return "RECONCILE_TERMINAL";
}
