import { apiFetch } from "@/lib/api-fetch";
import { isScanProgressResponse } from "./scan-progress-client";
import { hasActiveBackendWork, isAwaitingContinuation, type ScanProgressResponse } from "./scan-progress";

export const FINDER_DISCOVERY_INTERVAL_MS = 15_000;
export const FINDER_PROGRESS_INTERVAL_MS = 2_000;

/** Observation deliberately has no dependency on the POST /continue loop.
 * Terminal progress stops polling; the tiny run-ID discovery stays alive.
 * Abort cancels requests AND timers, including on filter change/unmount.
 */
export async function observeFinderRuns(filterId: string, signal: AbortSignal, callbacks: {
  onProgress: (progress: ScanProgressResponse | null) => void;
  onError: (message: string | null) => void;
  discoveryIntervalMs?: number;
  progressIntervalMs?: number;
}): Promise<void> {
  const discoveryInterval = callbacks.discoveryIntervalMs ?? FINDER_DISCOVERY_INTERVAL_MS;
  const progressInterval = callbacks.progressIntervalMs ?? FINDER_PROGRESS_INTERVAL_MS;
  let runId: string | null = null;
  let terminal = false;
  let nextDiscovery = 0;
  let nextProgress = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextDiscovery) {
        nextDiscovery = Date.now() + discoveryInterval;
        const response = await apiFetch(`/api/flip-finder/search-filters/${encodeURIComponent(filterId)}/latest-run`, { method: "GET", cache: "no-store", signal });
        const payload: unknown = await response.json();
        if (!response.ok || !payload || typeof payload !== "object" || !("runId" in payload) || !(payload.runId === null || typeof payload.runId === "string")) throw new Error("Nie udało się odczytać bieżącego skanu Findera.");
        signal.throwIfAborted();
        if (payload.runId !== runId) {
          runId = payload.runId;
          terminal = false;
          nextProgress = 0;
          callbacks.onProgress(null);
        }
        callbacks.onError(null);
      }
      if (runId && !terminal && Date.now() >= nextProgress) {
        nextProgress = Date.now() + progressInterval;
        const response = await apiFetch(`/api/flip-finder/scans/${encodeURIComponent(runId)}?observe=1&filterId=${encodeURIComponent(filterId)}`, { method: "GET", cache: "no-store", signal });
        const payload: unknown = await response.json();
        if (!response.ok || !isScanProgressResponse(payload) || payload.runId !== runId || payload.facebook.totalGroups > 0) throw new Error("Nie udało się odczytać postępu skanu Findera.");
        signal.throwIfAborted();
        callbacks.onProgress(payload);
        callbacks.onError(null);
        terminal = !hasActiveBackendWork(payload) && !isAwaitingContinuation(payload);
      }
    } catch (error) {
      if (signal.aborted) return;
      callbacks.onError(error instanceof Error ? error.message : "Nie udało się odczytać postępu skanu Findera.");
    }
    const nextTick = Math.min(nextDiscovery, runId && !terminal ? nextProgress : Infinity);
    await delay(Math.max(1, nextTick - Date.now()), signal);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
