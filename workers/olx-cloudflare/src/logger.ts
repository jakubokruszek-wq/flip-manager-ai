export type DiagnosticEvent = { timestamp: string; event: string; [key: string]: unknown };

/** Events worth keeping in /status (the full stream goes to Workers Logs / `wrangler tail`). */
const RETAINED_EVENTS = new Set([
  "JOB_START", "JOB_COMPLETE", "JOB_FAIL", "JOB_ERROR", "JOB_FAIL_REPORT_ERROR", "JOB_REJECTED_BUDGET", "JOB_RUNNER_ERROR", "JOB_DUPLICATE_CLAIM_IGNORED",
  "OLX_PAGE_VERIFIED", "OLX_CLOUD_PAUSED", "OLX_CLOUD_RESUMED", "BROWSER_SESSION_OPENED", "BROWSER_SESSION_CLOSED", "BROWSER_ACQUIRE_WAIT",
  "BROWSER_RESOURCE_BLOCKING_UNAVAILABLE", "WORKER_POLL_ERROR", "LEDGER_SAVE_ERROR", "RUNNER_ERROR",
]);

/**
 * Structured JSON logs. Callers never pass lease tokens or secrets (the shared
 * job runner already redacts them from error messages).
 */
export function createLogger(write: (line: string) => void = (line) => console.log(line)) {
  const kept: DiagnosticEvent[] = [];
  return {
    log(event: string, data: Record<string, unknown> = {}) {
      const entry: DiagnosticEvent = { timestamp: new Date().toISOString(), event, ...data };
      write(JSON.stringify(entry));
      if (RETAINED_EVENTS.has(event)) kept.push(entry);
    },
    recent(): DiagnosticEvent[] {
      return kept.slice(-40);
    },
  };
}
