export type OlxJobState = {
  id: string;
  idempotencyKey: string;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leasedUntil: number | null;
  heartbeatAt: number | null;
};

export function enqueueUnique(jobs: OlxJobState[], job: OlxJobState): OlxJobState[] {
  return jobs.some((existing) => existing.idempotencyKey === job.idempotencyKey) ? jobs : [...jobs, job];
}

export function claimNext(jobs: OlxJobState[], now: number, token: string): OlxJobState | null {
  recoverExpiredLeases(jobs, now);
  const job = jobs.find((candidate) => candidate.status === "queued") ?? null;
  if (!job) return null;
  job.status = "running";
  job.attempts += 1;
  job.leaseToken = token;
  job.leasedUntil = now + 120_000;
  job.heartbeatAt = now;
  return job;
}

export function heartbeat(job: OlxJobState, token: string, now: number): boolean {
  if (job.status !== "running" || job.leaseToken !== token) return false;
  job.heartbeatAt = now;
  job.leasedUntil = now + 120_000;
  return true;
}

export function recoverExpiredLeases(jobs: OlxJobState[], now: number): void {
  for (const job of jobs) {
    if (job.status !== "running" || job.leasedUntil === null || job.leasedUntil >= now) continue;
    job.status = job.attempts >= job.maxAttempts ? "failed" : "queued";
    job.leaseToken = null;
    job.leasedUntil = null;
  }
}
