import { apiFetch } from "@/lib/api-fetch";
import { hasActiveBackendWork, isAwaitingContinuation, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

/**
 * The one client-side scan-progress fetcher/validator, shared by every page
 * that polls a run (the main Finder dashboard and the filters list page).
 * A single contract here is what lets both pages agree on what "still
 * running" and "done" mean -- see isTerminalScanStatus/hasActiveBackendWork
 * in scan-progress.ts, which this always returns a value compatible with.
 */
export async function fetchScanProgress(runId: string, init: RequestInit = {}): Promise<ScanProgressResponse> {
  const response = await apiFetch(`/api/flip-finder/scans/${runId}`, { cache: "no-store", ...init });
  const payload = await readJson(response);
  if (!response.ok || !isScanProgressResponse(payload)) {
    throw new Error(readMessage(payload, "Nie udało się pobrać postępu skanu."));
  }
  return payload;
}

/**
 * Monitors the backend until terminal and executes ready portions of the
 * same run. Backend leases and watchdogs decide whether work is live or
 * recoverable; a fixed client polling cap would abandon legitimate progress.
 * Cancelling `signal` stops client requests; persisted work remains available
 * to the service continuation.
 */
export async function waitUntilScanTerminal(runId: string, signal: AbortSignal, pollIntervalMs = 1_000, onProgress?: (progress: ScanProgressResponse) => void): Promise<ScanProgressResponse> {
  let consecutiveFailures = 0;
  let continuationFailures = 0;
  let nextContinuationRequestAt = 0;
  let firstPoll = true;
  for (;;) {
    if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
    if (!firstPoll) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    firstPoll = false;
    if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
    const payload = await fetchScanProgress(runId, { signal }).catch((reason) => {
      if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
      return null;
    });
    if (!payload) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) throw new Error("Nie udało się odczytać postępu skanu.");
      continue;
    }
    consecutiveFailures = 0;
    if (payload.runId !== runId) throw new Error("SCAN_RUN_ID_MISMATCH");
    if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
    onProgress?.(payload);
    if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
    if (isAwaitingContinuation(payload)) {
      const ready = payload.continuation?.ready ?? !hasActiveBackendWork(payload);
      if (ready && Date.now() >= nextContinuationRequestAt) {
        // Only this exact existing run; never replay a filter's start URL.
        // Awaiting each bounded portion also prevents concurrent POSTs from
        // this tab. DB CAS protects against other tabs and the cron.
        nextContinuationRequestAt = Date.now() + Math.max(pollIntervalMs, 2_000);
        try {
          const response = await apiFetch(`/api/flip-finder/scans/${runId}/continue`, { method: "POST", signal });
          const result = await readJson(response);
          if (!response.ok) throw new Error(readMessage(result, "Nie udało się wznowić skanu."));
          if (!result || typeof result !== "object" || !("runId" in result) || result.runId !== runId) throw new Error("SCAN_RUN_ID_MISMATCH");
          continuationFailures = 0;
        } catch (reason) {
          if (signal.aborted) throw new DOMException("Polling cancelled", "AbortError");
          continuationFailures += 1;
          if (continuationFailures >= 3) throw reason;
          nextContinuationRequestAt = Date.now() + 10_000;
        }
      }
      continue;
    }
    if (hasActiveBackendWork(payload)) continue;
    return payload;
  }
}

export function isScanProgressResponse(value: unknown): value is ScanProgressResponse {
  return Boolean(value && typeof value === "object" && "runId" in value && "status" in value && "overall" in value && "facebook" in value && "olx" in value && "openai" in value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readMessage(value: unknown, fallback: string): string {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message;
  }

  return fallback;
}
