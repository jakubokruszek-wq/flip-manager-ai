const TERMINAL_SOURCE_STATUSES = new Set(["completed", "failed", "partial"]);

export type RadarRunActivityInput = {
  status: string;
  startedAt?: string;
  leaseUntil: string | null;
  stopRequestedAt?: string | null;
  userTerminatedAt?: string | null;
  errorMessage?: string | null;
  lastProgressAt?: string | null;
  olxJobStatus?: "queued" | "running" | "completed" | "failed" | "missing" | "unavailable";
  olxJobLeaseUntil?: string | null;
  sourceStatuses: Record<string, string>;
  checkpoint?: { sourceQueue?: string[]; currentSourceIndex?: number; lastProgressAt?: string };
};

export type RadarRunActivity = {
  status: string;
  currentSource: string | null;
  remainingSources: number;
  hasActiveLease: boolean;
  lastProgressAt: string | null;
};

/** Describes persisted Radar state; a stale `running` row is not active work. */
export function radarRunActivity(run: RadarRunActivityInput | null, now = Date.now()): RadarRunActivity {
  if (!run) return { status: "Oczekuje na pierwszy skan", currentSource: null, remainingSources: 0, hasActiveLease: false, lastProgressAt: null };

  const queue = Array.isArray(run.checkpoint?.sourceQueue) ? run.checkpoint.sourceQueue : [];
  const statuses = run.sourceStatuses ?? {};
  const remainingSources = new Set(queue.filter((source) => !TERMINAL_SOURCE_STATUSES.has(statuses[source] ?? "pending"))).size;
  const currentSource = findCurrentSource(queue, statuses, run.checkpoint?.currentSourceIndex ?? 0);
  const leaseUntil = run.leaseUntil ? Date.parse(run.leaseUntil) : Number.NaN;
  const hasActiveLease = Number.isFinite(leaseUntil) && leaseUntil > now;
  const lastProgressAt = validTimestamp(run.lastProgressAt) ?? validTimestamp(run.checkpoint?.lastProgressAt);

  let status: string;
  if (run.userTerminatedAt) status = "Zakończony przez użytkownika";
  else if (run.errorMessage === "RADAR_STOPPED_BY_OPERATOR") status = "Zatrzymano";
  else if (run.stopRequestedAt) status = hasActiveLease ? "Zatrzymywanie" : "Zatrzymano";
  else if (run.status === "completed") status = "Zakończono";
  else if (run.status === "partial") status = "Częściowe pokrycie";
  else if (run.status === "failed") status = "Błąd terminalny";
  else if (statuses.olx === "running") status = olxActivityStatus(run, hasActiveLease, now);
  else if (!hasActiveLease || run.status === "pending") status = "Oczekiwanie na kontynuację";
  else status = currentSource ? `Skanowanie trwa — ${currentSource}` : "Skanowanie trwa — zapisywanie checkpointu";

  return { status, currentSource, remainingSources, hasActiveLease, lastProgressAt };
}

function olxActivityStatus(run: RadarRunActivityInput, hasActiveLease: boolean, now: number): string {
  if (run.olxJobStatus === "queued") return "Oczekiwanie na worker OLX";
  if (run.olxJobStatus === "running") {
    const jobLeaseUntil = run.olxJobLeaseUntil ? Date.parse(run.olxJobLeaseUntil) : Number.NaN;
    return hasActiveLease && Number.isFinite(jobLeaseUntil) && jobLeaseUntil > now
      ? "Worker OLX pobiera oferty"
      : "Oczekiwanie na kontynuację OLX";
  }
  if (run.olxJobStatus === "failed") return "Błąd terminalny workera OLX";
  if (run.olxJobStatus === "completed") return "Oczekiwanie na zapis checkpointu OLX";
  if (run.olxJobStatus === "missing") return "Brak zadania workera OLX — oczekiwanie na kontynuację";
  if (run.olxJobStatus === "unavailable") return "Nie można potwierdzić stanu workera OLX";
  return hasActiveLease ? "Oczekiwanie na worker OLX" : "Oczekiwanie na kontynuację OLX";
}

function findCurrentSource(queue: string[], statuses: Record<string, string>, currentIndex: number): string | null {
  const running = queue.find((source) => statuses[source] === "running");
  if (running) return running;
  if (queue.length === 0) return null;
  const safeStart = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < queue.length ? currentIndex : 0;
  for (let offset = 0; offset < queue.length; offset += 1) {
    const source = queue[(safeStart + offset) % queue.length];
    if (!TERMINAL_SOURCE_STATUSES.has(statuses[source] ?? "pending")) return source ?? null;
  }
  return null;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
/** Counts fixed queue slots already durably passed, including decisions skipped during a run. */
export function radarVerificationBacklogProgress(checkpoint: unknown): { checked: number; total: number } | null {
  if (!checkpoint || typeof checkpoint !== "object" || !("verificationBacklog" in checkpoint)) return null;
  const backlog = checkpoint.verificationBacklog;
  if (!backlog || typeof backlog !== "object" || Array.isArray(backlog)) return null;
  let checked = 0;
  let total = 0;
  for (const state of Object.values(backlog)) {
    if (!state || typeof state !== "object" || !Array.isArray(state.ids)) continue;
    const count = state.ids.length;
    total += count;
    const index = state.cursor && typeof state.cursor.candidateIndex === "number" ? state.cursor.candidateIndex : 0;
    checked += state.done === true ? count : Math.max(0, Math.min(count, Number.isFinite(index) ? Math.floor(index) : 0));
  }
  return total ? { checked, total } : null;
}

