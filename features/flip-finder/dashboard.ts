import type { SearchFilterScan } from "@/features/flip-finder/search-filter-contract";

export const NO_SCANS_MESSAGE = "Nie uruchomiono jeszcze żadnego skanu ofert.";

export function dashboardCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const COLLECTOR_READINESS_ATTEMPTS = 3;
export const COLLECTOR_READINESS_RETRY_DELAY_MS = 500;
export const COLLECTOR_BOOTSTRAP_MAX_WAIT_MS = 3_000;
export const COLLECTOR_BOOTSTRAP_POLL_INTERVAL_MS = 125;
export const START_TRACE_ORDER = ["BUTTON_CLICKED", "READY_REQUEST_SENT", "BRIDGE_RECEIVED_READY", "EXTENSION_RECEIVED_READY", "EXTENSION_READY_RESULT", "BRIDGE_RETURNED_READY", "PAGE_RECEIVED_READY", "HEALTH_REFRESH_SENT", "HEALTH_REFRESH_RESPONSE", "HEARTBEAT_UPDATED", "POST_SCAN_SENT", "POST_SCAN_RESPONSE", "NEW_SCAN_RUN_ID", "SCAN_COMMAND_SENT", "BRIDGE_RECEIVED_SCAN_COMMAND", "EXTENSION_RECEIVED_SCAN_COMMAND", "COLLECTOR_STARTED", "COLLECTOR_BATCH_CREATED"] as const;
export type StartTraceDiagnosticStage = { stage: string; status: "PASS" | "FAIL" | "TIMEOUT"; errorCode?: string };

type BootstrapReadinessOptions = {
  readMarker: () => string | null;
  ping: () => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type BootstrapReadinessResult = {
  ok: boolean;
  source: "marker" | "pong" | null;
  error?: "BOOTSTRAP_START_TIMEOUT";
};

export async function waitForCollectorBootstrap({
  readMarker,
  ping,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = COLLECTOR_BOOTSTRAP_MAX_WAIT_MS,
  pollIntervalMs = COLLECTOR_BOOTSTRAP_POLL_INTERVAL_MS,
}: BootstrapReadinessOptions): Promise<BootstrapReadinessResult> {
  const startedAt = now();
  while (true) {
    const marker = readMarker();
    if (await ping()) return { ok: true, source: "pong" };

    if (marker && marker !== "stale") {
      const remainingMs = timeoutMs - (now() - startedAt);
      if (remainingMs > 0) {
        await sleep(Math.min(pollIntervalMs, remainingMs));
        if (await ping()) return { ok: true, source: "pong" };
      }
      return { ok: true, source: "marker" };
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return { ok: false, source: null, error: "BOOTSTRAP_START_TIMEOUT" };
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export function summarizeStartTrace(stages: StartTraceDiagnosticStage[]) {
  const real = stages.filter((item) => item.stage !== "START_FAILED");
  const failed = real.find((item) => item.status !== "PASS") ?? null;
  const passed = new Set(real.filter((item) => item.status === "PASS").map((item) => item.stage));
  const firstMissing = failed ? null : START_TRACE_ORDER.find((stage) => !passed.has(stage)) ?? null;
  const lastSuccessful = [...real].reverse().find((item) => item.status === "PASS")?.stage ?? null;
  return { lastSuccessful, firstFailed: failed?.stage ?? null, firstMissing, errorCode: failed?.errorCode ?? null };
}

export async function retryCollectorReadiness<T extends { ok: boolean }>(request: () => Promise<T>, onRetry: (attempt: number) => void, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  let last: T | null = null;
  for (let attempt = 1; attempt <= COLLECTOR_READINESS_ATTEMPTS; attempt += 1) {
    if (attempt > 1) { onRetry(attempt); await sleep(COLLECTOR_READINESS_RETRY_DELAY_MS); }
    last = await request();
    if (last.ok) return last;
  }
  return last as T;
}

export function latestScanCounters(
  scan: Pick<SearchFilterScan, "listingsUpdated" | "priceDropCount">,
): { updatedCount: number; priceDropCount: number } {
  return {
    updatedCount: dashboardCount(scan.listingsUpdated),
    priceDropCount: dashboardCount(scan.priceDropCount),
  };
}

export function canRunManualScan(isActive: boolean, scanning: boolean): boolean {
  return isActive && !scanning;
}

export function filterResultsHref(filterId: string): string {
  return `/flip-finder/filters/${filterId}/results`;
}

export function hasLatestScan(scan: SearchFilterScan | null): scan is SearchFilterScan {
  return scan !== null;
}

export function scanStatusLabel(status: SearchFilterScan["status"]): string {
  switch (status) {
    case "pending":
      return "Oczekuje";
    case "running":
      return "Skanowanie";
    case "completed":
      return "Zakończony";
    case "partial":
      return "Częściowo zakończony";
    case "failed":
      return "Błąd";
  }
}
