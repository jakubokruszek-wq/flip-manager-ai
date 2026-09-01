export type CollectorScanFailure = {
  errorCode: string;
  stage: string | null;
  query: string | null;
  tabId: number | null;
  elapsedMs: number | null;
  source: string | null;
};

export function parseCollectorScanFailure(body: string): CollectorScanFailure {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { /* use a safe generic failure */ }
  return {
    errorCode: safeCode(value.error),
    stage: safeText(value.stage, 80),
    query: safeText(value.query, 120),
    tabId: safeInteger(value.tabId),
    elapsedMs: safeInteger(value.elapsedMs),
    source: safeText(value.source, 160),
  };
}

export function collectorScanFailurePatch(input: CollectorScanFailure, existing: { warnings?: unknown; diagnostics?: unknown }, now: string) {
  const previousWarnings = Array.isArray(existing.warnings) ? existing.warnings.filter((item): item is string => typeof item === "string") : [];
  const previousDiagnostics = Array.isArray(existing.diagnostics) ? existing.diagnostics.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
  return {
    status: "failed" as const,
    finished_at: now,
    error_message: `COLLECTOR_SCAN_FAILED: ${input.errorCode}`,
    warnings: [...new Set([...previousWarnings, input.errorCode])].slice(0, 100),
    diagnostics: [...previousDiagnostics, {
      errorCode: input.errorCode,
      lastStage: input.stage,
      query: input.query,
      tabId: input.tabId,
      elapsedMs: input.elapsedMs,
      source: input.source,
      failedAt: now,
    }].slice(-100),
  };
}

function safeCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(code) ? code : "COLLECTOR_SCAN_FAILED";
}

function safeText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
