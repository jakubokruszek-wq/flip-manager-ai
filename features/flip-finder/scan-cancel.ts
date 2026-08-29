export function isValidScanRunId(runId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId);
}

export function cancellationPatch(now: string) {
  return { status: "failed" as const, error_code: "SCAN_CANCELLED", error_message: "Scan cancelled by user", leased_until: null, finished_at: now };
}
