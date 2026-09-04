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

export async function withExclusiveSchedulerLock<T>(input: {
  acquire: () => Promise<string | null>;
  release: (owner: string) => Promise<void>;
  task: () => Promise<T>;
}): Promise<T | null> {
  const owner = await input.acquire();
  if (!owner) return null;
  try { return await input.task(); }
  finally { await input.release(owner); }
}

export function orderSchedulerSources(sources: SchedulerSource[]): SchedulerSource[] {
  const seen = new Set<string>();
  return [...sources].sort((left, right) => PRIORITY[left.priority] - PRIORITY[right.priority]
    || left.createdAt.localeCompare(right.createdAt)
    || left.sourceId.localeCompare(right.sourceId)).filter((source) => {
      if (seen.has(source.sourceId)) return false;
      seen.add(source.sourceId);
      return true;
    });
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

export type SchedulerCycleDecision =
  | { type: "ADVANCE"; source: SchedulerSource }
  | { type: "WAIT_COOLDOWN"; nextCycleAt: number }
  | { type: "START_NEXT_CYCLE"; nextCycleAt: number };

export function schedulerCycleDecision(input: {
  plan: SchedulerSource[];
  terminalSourceIds: string[];
  cycleStartedAt: string;
  cooldownMinutes: number;
  nowMs: number;
}): SchedulerCycleDecision {
  const source = nextSchedulerSource(input.plan, input.terminalSourceIds, []);
  if (source) return { type: "ADVANCE", source };
  const nextCycleAt = Date.parse(input.cycleStartedAt) + schedulerCooldownMinutes(input.cooldownMinutes) * 60_000;
  return input.nowMs < nextCycleAt ? { type: "WAIT_COOLDOWN", nextCycleAt } : { type: "START_NEXT_CYCLE", nextCycleAt };
}

export function activeJobDecision(job: { status: string; attempts: number; createdAt: string | null; heartbeatAt: string | null }, nowMs = Date.now()): ActiveJobDecision {
  if (job.status === "queued" && job.attempts === 0 && isStaleAt(job.createdAt, 90_000, nowMs)) return "FAIL_NEVER_CLAIMED";
  if (job.status === "running" && isStaleAt(job.heartbeatAt, 8 * 60_000, nowMs)) return "FAIL_NO_PROGRESS";
  if (job.status === "queued" || job.status === "running") return "WAIT";
  return "RECONCILE_TERMINAL";
}
