import { apiFetch } from "@/lib/api-fetch";
import { hasActiveBackendWork, isTerminalScanStatus, type ScanProgressResponse } from "@/features/flip-finder/scan-progress";

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
 * Polls for as long as the backend itself reports active work -- never on a
 * fixed attempt cap. The server's own staleness watchdog (15 minutes of no
 * heartbeat; see scan-lifecycle.ts) is what eventually ends a genuinely
 * abandoned run; a fixed client-side cap shorter than that previously made
 * SearchFiltersPage falsely report a timeout for a legitimately slow but
 * healthy scan. Cancelled via `signal` (e.g. on unmount) -- the background
 * worker the run id refers to is unaffected either way.
 */
export async function waitUntilScanTerminal(runId: string, signal: AbortSignal, pollIntervalMs = 1_000): Promise<ScanProgressResponse> {
  let consecutiveFailures = 0;
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
    if (hasActiveBackendWork(payload) && !isTerminalScanStatus(payload.status)) continue;
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
