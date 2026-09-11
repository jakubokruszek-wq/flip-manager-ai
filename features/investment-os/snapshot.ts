import type { CeoDecisionContract, ConfidenceAxes, DirectorStatus, FoundationDirectorName } from "./types";

export type SnapshotEvidenceRef = { id: string; field: string | null; evidenceType: string | null; provenance: string | null; observedAt: string | null; supersedesEvidenceId: string | null };
export type SnapshotDirectorState = { director: FoundationDirectorName; status: DirectorStatus; runId: string | null; inputFingerprint: string | null; directorVersion: number | null; computedAt: string | null; confidence: ConfidenceAxes; stale: boolean };
export type DealSnapshot = { dealId: string; listingId: string; stage: string; effectiveFacts: Record<string, unknown>; evidence: SnapshotEvidenceRef[]; directors: SnapshotDirectorState[]; ceoDecision: CeoDecisionContract | null; assembledAt: string };

export function assembleDealSnapshot(input: {
  deal: { id: string; listingId: string; stage: string; facts: Record<string, { effectiveValue?: unknown }>; updatedAt?: string };
  evidence: SnapshotEvidenceRef[];
  directorRuns: Array<{ id: string; director: FoundationDirectorName; status: DirectorStatus; inputFingerprint: string; directorVersion: number; computedAt: string }>;
  ceoDecisions?: CeoDecisionContract[];
  asOf?: string;
}): DealSnapshot {
  const asOf = input.asOf ?? new Date().toISOString();
  const latest = new Map<FoundationDirectorName, SnapshotDirectorState>();
  for (const run of [...input.directorRuns].sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt))) {
    if (latest.has(run.director)) continue;
    latest.set(run.director, { director: run.director, status: run.status, runId: run.id, inputFingerprint: run.inputFingerprint, directorVersion: run.directorVersion, computedAt: run.computedAt, confidence: { data: null, method: null, market: null }, stale: run.status === "STALE" });
  }
  const effectiveFacts = Object.fromEntries(Object.entries(input.deal.facts).map(([field, fact]) => [field, fact?.effectiveValue ?? null]));
  const ceoDecision = [...(input.ceoDecisions ?? [])].sort((a, b) => b.decisionVersion - a.decisionVersion || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  return { dealId: input.deal.id, listingId: input.deal.listingId, stage: input.deal.stage, effectiveFacts, evidence: input.evidence, directors: [...latest.values()], ceoDecision, assembledAt: asOf };
}
