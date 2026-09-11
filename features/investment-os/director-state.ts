import type { DirectorStatus } from "./types";

export type DirectorRunState = { id: string; dealId: string; director: string; status: DirectorStatus; inputFingerprint: string; directorVersion: number; attempt: number; queuedAt: string; startedAt: string | null; finishedAt: string | null; failureReason: string | null; staleReason?: string | null };
const transitions: Record<DirectorStatus, DirectorStatus[]> = { NOT_RUN: ["READY", "QUEUED"], READY: ["QUEUED", "RUNNING", "STALE", "FAILED"], QUEUED: ["RUNNING", "STALE", "FAILED"], RUNNING: ["COMPLETE", "STALE", "FAILED"], COMPLETE: ["STALE"], STALE: ["READY", "QUEUED"], BLOCKED: ["STALE", "READY"], FAILED: ["STALE", "READY"] };

export function canTransition(from: DirectorStatus, to: DirectorStatus): boolean { return from === to || transitions[from].includes(to); }
export function transitionRun(run: DirectorRunState, status: DirectorStatus, now: string, reason?: string): DirectorRunState {
  if (!canTransition(run.status, status)) throw new Error(`DIRECTOR_INVALID_TRANSITION:${run.status}->${status}`);
  return { ...run, status, startedAt: status === "RUNNING" && !run.startedAt ? now : run.startedAt, finishedAt: ["COMPLETE", "STALE", "FAILED", "BLOCKED"].includes(status) ? now : run.finishedAt, failureReason: status === "FAILED" ? reason ?? run.failureReason ?? "DIRECTOR_FAILED" : run.failureReason, staleReason: status === "STALE" ? reason ?? "INPUT_CHANGED" : run.staleReason };
}
export function isStaleWrite(runFingerprint: string, currentFingerprint: string): boolean { return runFingerprint !== currentFingerprint; }
export function shouldReuseComplete(run: Pick<DirectorRunState, "status" | "inputFingerprint" | "directorVersion">, fingerprint: string, directorVersion: number): boolean { return run.status === "COMPLETE" && run.inputFingerprint === fingerprint && run.directorVersion === directorVersion; }
