export type FilterScanState = {
  status: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
  coverageComplete?: boolean | null;
  expectedQueries?: number | null;
  completedQueries?: number | null;
};

export type NegativeReconciliationDecision = {
  allowed: boolean;
  reason:
    | "COMPLETE_SCAN"
    | "EXPLICIT_MANUAL_RECALCULATION"
    | "SCAN_NOT_TERMINAL"
    | "SCAN_FAILED"
    | "SCAN_PARTIAL_COVERAGE_INSUFFICIENT"
    | "SCAN_NOT_FINISHED"
    | "SCAN_FATAL_ERROR"
    | "SCAN_QUERY_COVERAGE_INSUFFICIENT";
};

/**
 * Negative membership changes require a completed, trustworthy observation.
 * A failed transport/query or an incomplete partial scan never proves that an
 * old result disappeared from the market.
 */
export function canReconcileNegativeResults(input: FilterScanState): NegativeReconciliationDecision {
  const status = input.status?.toLowerCase() ?? null;
  if (status === "failed") return { allowed: false, reason: "SCAN_FAILED" };
  if (status === "partial") {
    if (input.coverageComplete !== true) return { allowed: false, reason: "SCAN_PARTIAL_COVERAGE_INSUFFICIENT" };
  } else if (status !== "completed") {
    return { allowed: false, reason: "SCAN_NOT_TERMINAL" };
  }

  if (!input.finishedAt || !Number.isFinite(Date.parse(input.finishedAt))) {
    return { allowed: false, reason: "SCAN_NOT_FINISHED" };
  }

  if (input.expectedQueries !== null && input.expectedQueries !== undefined && input.completedQueries !== null && input.completedQueries !== undefined && input.completedQueries < input.expectedQueries) {
    return { allowed: false, reason: "SCAN_QUERY_COVERAGE_INSUFFICIENT" };
  }

  if (input.errorMessage && /(?:TIMEOUT|FAILED|FATAL|UNAVAILABLE|ERROR|CANCEL)/i.test(input.errorMessage)) {
    return { allowed: false, reason: "SCAN_FATAL_ERROR" };
  }

  return { allowed: true, reason: "COMPLETE_SCAN" };
}

export function reviewMembership(match: { isCurrentMatch: boolean; matchReasons: string[] }): boolean {
  return !match.isCurrentMatch && match.matchReasons.some((reason) => reason === "review" || reason.startsWith("unknown_"));
}

export function visibleMembership(match: { isCurrentMatch: boolean; matchReasons: string[] }): boolean {
  return match.isCurrentMatch || reviewMembership(match);
}

export function reconciliationMembershipState(isCurrentMatch: boolean, matchReasons: string[]): "MATCHED" | "REVIEW" | "INACTIVE" {
  if (isCurrentMatch) return "MATCHED";
  return reviewMembership({ isCurrentMatch, matchReasons }) ? "REVIEW" : "INACTIVE";
}

export type MembershipAuditEntry = {
  filterId: string;
  listingId: string;
  previousState: "MATCHED" | "REVIEW" | "INACTIVE" | "NONE";
  newState: "MATCHED" | "REVIEW" | "INACTIVE" | "NONE";
  reason: string;
  scanRunId: string | null;
  timestamp: string;
};

export function membershipAuditEntry(input: Omit<MembershipAuditEntry, "timestamp"> & { timestamp?: string }): MembershipAuditEntry {
  return {
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
