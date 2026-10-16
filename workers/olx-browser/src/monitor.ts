import type { WorkerJob } from "./api-client.ts";
import type { OlxJobSummary } from "./job-runner.ts";

export type WorkerState = "starting" | "polling" | "idle" | "running_job" | "cooldown" | "stopping";

type LastJob = OlxJobSummary & { contextType: string; attempt: number; finishedAt: string };

/**
 * In-memory operational counters for one worker process. Everything here is
 * safe to log: job ids and counts only, never lease tokens, URLs or secrets.
 */
export function createWorkerMonitor(options: { workerId: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let state: WorkerState = "starting";
  let lastPollOkAt: number | null = null;
  let lastPollErrorAt: number | null = null;
  let lastPollError: string | null = null;
  let consecutivePollErrors = 0;
  let lastClaimAt: number | null = null;
  let activeJob: { id: string; contextType: string; attempt: number; startedAt: number } | null = null;
  let lastJob: LastJob | null = null;
  let cooldownUntil: string | null = null;
  const totals = { polls: 0, pollErrors: 0, claimed: 0, completed: 0, failed: 0, leaseLost: 0, shutdown: 0, accessDenied: 0, rawItems: 0, normalizedItems: 0 };

  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

  return {
    setState(next: WorkerState, details: { cooldownUntil?: string | null } = {}) {
      state = next;
      if (next === "cooldown") cooldownUntil = details.cooldownUntil ?? cooldownUntil;
      else cooldownUntil = null;
    },
    recordPoll(job: WorkerJob | null) {
      totals.polls += 1;
      lastPollOkAt = now();
      consecutivePollErrors = 0;
      if (!job) return;
      totals.claimed += 1;
      lastClaimAt = lastPollOkAt;
      activeJob = { id: job.id, contextType: job.contextType ?? "finder", attempt: job.attempts, startedAt: lastPollOkAt };
    },
    recordPollError(message: string) {
      totals.pollErrors += 1;
      consecutivePollErrors += 1;
      lastPollErrorAt = now();
      lastPollError = message.slice(0, 200);
    },
    recordJob(summary: OlxJobSummary, accessDenied: boolean): LastJob {
      if (summary.outcome === "completed") totals.completed += 1;
      else if (summary.outcome === "failed") totals.failed += 1;
      else if (summary.outcome === "lease_lost") totals.leaseLost += 1;
      else totals.shutdown += 1;
      if (accessDenied) totals.accessDenied += 1;
      if (summary.outcome === "completed") {
        totals.rawItems += summary.rawItems ?? 0;
        totals.normalizedItems += summary.normalizedItems ?? 0;
      }
      lastJob = {
        ...summary,
        contextType: activeJob?.id === summary.jobId ? activeJob.contextType : "unknown",
        attempt: activeJob?.id === summary.jobId ? activeJob.attempt : 0,
        finishedAt: new Date(now()).toISOString(),
      };
      activeJob = null;
      return lastJob;
    },
    snapshot() {
      return {
        workerId: options.workerId,
        state,
        uptimeSec: Math.round((now() - startedAt) / 1000),
        lastPollOkAt: iso(lastPollOkAt),
        lastPollErrorAt: iso(lastPollErrorAt),
        lastPollError,
        consecutivePollErrors,
        lastClaimAt: iso(lastClaimAt),
        activeJob: activeJob ? { jobId: activeJob.id, contextType: activeJob.contextType, attempt: activeJob.attempt, runningSec: Math.round((now() - activeJob.startedAt) / 1000) } : null,
        lastJob,
        cooldownUntil,
        totals: { ...totals },
      };
    },
  };
}

export type WorkerMonitor = ReturnType<typeof createWorkerMonitor>;
