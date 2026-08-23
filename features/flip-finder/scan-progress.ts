import type { ListingSource } from "@/features/flip-finder";

export type ScanProgressStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type WorkerJobStatus = "queued" | "running" | "completed" | "failed";
export type VisionCostDataQuality = "EXACT" | "PARTIAL" | "UNAVAILABLE";

export type ScanWorkUnit = {
  id: string;
  source: ListingSource;
  status: "pending" | "running" | "completed" | "partial" | "failed";
  startedAt: string;
  finishedAt: string | null;
  scannedCount: number;
  matchedCount: number;
  normalizedCount: number;
  errorMessage: string | null;
};

export type FacebookGroupProgress = {
  groupId: string | null;
  groupName: string;
  jobId: string;
  sourceScanId: string;
  status: WorkerJobStatus;
  discovered: number;
  processed: number;
  errorMessage: string | null;
};

export type OpenAICostWindow = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  dataQuality: VisionCostDataQuality;
  models: string[];
};

export type ScanProgressResponse = {
  runId: string;
  status: ScanProgressStatus;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  overall: {
    completedUnits: number;
    totalUnits: number;
    percent: number;
    failedUnits: number;
    remainingUnits: number;
  };
  current: { source: ListingSource; groupName: string | null } | null;
  facebook: {
    totalGroups: number;
    completedGroups: number;
    runningGroups: number;
    queuedGroups: number;
    failedGroups: number;
    discovered: number;
    processed: number;
    groups: FacebookGroupProgress[];
  };
  olx: {
    status: WorkerJobStatus | null;
    raw: number;
    normalized: number;
    processed: number;
    errorMessage: string | null;
  };
  totals: {
    scanned: number;
    matched: number;
    updated: number;
    priceDrops: number;
  };
  errors: string[];
  openai: {
    lastRun: OpenAICostWindow;
    today: OpenAICostWindow;
    month: OpenAICostWindow;
    monthlyBudgetUsd: number | null;
    remainingBudgetUsd: number | null;
    budgetUsedPercent: number | null;
    balanceUsd: null;
    balanceStatus: "UNAVAILABLE";
  };
};

export function buildOverallProgress(units: ScanWorkUnit[], jobStatuses: WorkerJobStatus[]): ScanProgressResponse["overall"] & { status: ScanProgressStatus } {
  const terminalUnits = units.filter((unit) => isTerminalUnitStatus(unit.status)).length;
  const failedUnits = units.filter((unit) => unit.status === "failed").length;
  const totalUnits = units.length;
  const allQueued = totalUnits > 0 && terminalUnits === 0 && units.every((unit) => unit.status === "pending") && jobStatuses.length > 0 && jobStatuses.every((status) => status === "queued");
  const hasActive = units.some((unit) => unit.status === "pending" || unit.status === "running");
  const status: ScanProgressStatus = allQueued
    ? "queued"
    : hasActive
      ? "running"
      : failedUnits === totalUnits && totalUnits > 0
        ? "failed"
        : failedUnits > 0 || units.some((unit) => unit.status === "partial")
          ? "partial"
          : "completed";

  return {
    status,
    completedUnits: terminalUnits,
    totalUnits,
    percent: totalUnits > 0 ? Math.round((terminalUnits / totalUnits) * 100) : 100,
    failedUnits,
    remainingUnits: Math.max(0, totalUnits - terminalUnits),
  };
}

export function isTerminalScanStatus(status: ScanProgressStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

export function isTerminalUnitStatus(status: ScanWorkUnit["status"]): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

export function calculateBudget(monthCostUsd: number | null, monthlyBudgetUsd: number | null) {
  if (monthlyBudgetUsd === null || !Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd <= 0) {
    return { remainingBudgetUsd: null, budgetUsedPercent: null };
  }
  const cost = typeof monthCostUsd === "number" && Number.isFinite(monthCostUsd) ? Math.max(0, monthCostUsd) : 0;
  return {
    remainingBudgetUsd: Math.max(0, monthlyBudgetUsd - cost),
    budgetUsedPercent: (cost / monthlyBudgetUsd) * 100,
  };
}

export function budgetTone(percent: number | null): "normal" | "info" | "warning" | "critical" {
  if (percent === null || percent < 50) return "normal";
  if (percent < 80) return "info";
  if (percent < 95) return "warning";
  return "critical";
}
