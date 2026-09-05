import type { ListingSource } from "@/features/flip-finder";

export type ScanProgressStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type WorkerJobStatus = "queued" | "running" | "completed" | "failed";
export type VisionCostDataQuality = "EXACT" | "PARTIAL" | "UNAVAILABLE";

/** Safe proof fields for an END_OF_RESULTS_CONFIRMED discovery stop. */
export type CollectorSearchDiscoveryEvidence = {
  scrollAttempts: number;
  reachedBottom: boolean;
  consecutiveBottomChecks: number;
  stableScrollPosition: boolean;
  urlStable: boolean;
  pageErrorFree: boolean;
  consecutiveNoGrowthChecks: number;
  consecutiveNoVisibleGrowthChecks: number;
  networkQuietChecks: number;
  noPendingContent: boolean;
  finalScrollTop: number;
  finalScrollHeight: number;
  viewportHeight: number;
  uniqueTileProgression: number[];
};

export type CollectorSearchQueryTelemetry = {
  query: string;
  executed: boolean;
  status: "HEALTHY" | "DEGRADED" | "FAILED";
  scrolls: number;
  scrollCount?: number | null;
  visibleCards: number;
  captured: number;
  unique: number;
  duplicatesVsMainFeed: number;
  uniqueContribution: number;
  sellContribution: number;
  tilesSeen: number;
  tilesOpened: number;
  tilesResolved: number;
  tilesUnverified: number;
  uniqueParentPosts: number;
  verifiedParentPosts: number;
  duplicatesByMedia: number;
  discoveryDurationMs?: number | null;
  resolutionDurationMs?: number | null;
  discoveryDuration?: number | null;
  resolutionDuration?: number | null;
  rawTilesSeen?: number | null;
  uniqueTilesFound?: number | null;
  candidateBufferSize?: number | null;
  candidateCapReached?: boolean | null;
  resolutionCandidates?: number | null;
  payloadObserved?: number | null;
  discoveryStopReason?: string | null;
  resolutionStopReason?: string | null;
  discoveryEvidence?: CollectorSearchDiscoveryEvidence | null;
  tabLoadAttempts?: number | null;
  tabLoadRecovery?: string | null;
  durationMs: number;
  stopReason: string;
  tileDiagnostics: CollectorSearchTileDiagnostic[];
};

/** Safe, read-only projection of a collector tile diagnostic. */
export type CollectorSearchTileDiagnostic = {
  query: string;
  tileIndex: number;
  mediaUrl: string | null;
  mediaId: string | null;
  initialUrl: string | null;
  finalUrl: string | null;
  tabStatus: string | null;
  injectAttempted: boolean;
  injectSuccess: boolean;
  injectError: string | null;
  sendMessageError: string | null;
  photoOpenedAt: string | null;
  contentScriptReadyAt: string | null;
  sendMessageAttemptCount: number;
  sendMessageFirstAt: string | null;
  sendMessageSuccessAt: string | null;
  payloadObservedAt: string | null;
  responseAt: string | null;
  photoPageOpened: boolean;
  payloadObserved: boolean;
  currMediaFound: boolean;
  containerStoryFound: boolean;
  parentPostIdFound: boolean;
  parentPermalinkFound: boolean;
  parentStoryFound: boolean;
  authorFound: boolean;
  rootTextFound: boolean;
  exactBinding: boolean;
  timeSpentMs: number;
  firstFailedHop: string | null;
};

export type CollectorMainFeedDiagnostic = {
  postId: string;
  sourceLayer: "NETWORK" | "DOM" | "BOTH";
  structuredAuthorPresent: boolean;
  structuredTextPresent: boolean;
  structuredTextPath: string | null;
  rootCardFound: boolean;
  rootCardPostIdBound: boolean;
  rootCardPermalink: string | null;
  rootAuthorFound: boolean;
  rootTextFound: boolean;
  seeMorePresent: boolean;
  seeMoreClicked: boolean;
  rootTextAfterExpand: boolean;
  authorMatch: boolean;
  postIdMatch: boolean;
  finalIdentity: "EXACT" | "UNVERIFIED";
  failSubstep: string | null;
};

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

export type CollectorScanFunnel = {
  collected: number;
  exact: number;
  sellProperty: number;
  rejected: number;
  listingsCreated: number;
  listingsUpdated: number;
  rejections: {
    identityUnverified: number;
    searchParentUnverified: number;
    buildingTypeUnverified: number;
    rent: number;
    ageCutoff: number;
    outsideLodz: number;
    tenement: number;
    duplicate: number;
    other: number;
  };
  search: {
    queriesExecuted: number;
    queriesPlanned: number;
    globalTimeBudgetExhausted: boolean;
    queries: CollectorSearchQueryTelemetry[];
  };
  mainFeedDiagnostics: CollectorMainFeedDiagnostic[];
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
    created: number;
    updated: number;
    priceDrops: number;
  };
  collector: CollectorScanFunnel | null;
  partialReason: string | null;
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

export function projectSearchTileDiagnostics(value: unknown, query: string, limit = 50): CollectorSearchTileDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const boundedLimit = Math.max(0, Math.min(50, Math.floor(limit)));
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, boundedLimit).map((item, tileIndex) => {
    const id = numericId(item.mediaId);
    const parentPostId = numericId(item.parentPostId);
    const containerStoryPostId = numericId(item.containerStoryPostId);
    const parentPermalink = facebookPermalink(item.parentPermalink);
    return {
      query, tileIndex, mediaUrl: facebookPhotoUrl(item.mediaUrl), mediaId: id,
      initialUrl: facebookPhotoUrl(item.initialUrl), finalUrl: facebookPhotoUrl(item.finalUrl),
      tabStatus: typeof item.tabStatus === "string" ? item.tabStatus.slice(0, 30) : null,
      injectAttempted: item.injectAttempted === true, injectSuccess: item.injectSuccess === true,
      injectError: safeDiagnosticError(item.injectError), sendMessageError: safeDiagnosticError(item.sendMessageError),
      photoOpenedAt: isoTimestamp(item.photoOpenedAt),
      contentScriptReadyAt: isoTimestamp(item.contentScriptReadyAt),
      sendMessageAttemptCount: nonnegativeInteger(item.sendMessageAttemptCount),
      sendMessageFirstAt: isoTimestamp(item.sendMessageFirstAt),
      sendMessageSuccessAt: isoTimestamp(item.sendMessageSuccessAt),
      payloadObservedAt: isoTimestamp(item.payloadObservedAt),
      responseAt: isoTimestamp(item.responseAt),
      photoPageOpened: item.photoOpened === true,
      payloadObserved: item.structuredPayloadFound === true,
      currMediaFound: Boolean(numericId(item.currMediaId)),
      containerStoryFound: Boolean(containerStoryPostId),
      parentPostIdFound: Boolean(parentPostId),
      parentPermalinkFound: Boolean(parentPermalink),
      parentStoryFound: Boolean(containerStoryPostId && (parentPostId === containerStoryPostId || parentPostId)),
      authorFound: item.rootAuthorFound === true,
      rootTextFound: item.rootTextFound === true,
      exactBinding: item.identityResult === "EXACT",
      timeSpentMs: nonnegativeInteger(item.elapsedMs),
      firstFailedHop: typeof item.failSubstep === "string" ? item.failSubstep : null,
    };
  });
}

export function buildOverallProgress(units: ScanWorkUnit[], jobStatuses: WorkerJobStatus[]): ScanProgressResponse["overall"] & { status: ScanProgressStatus } {
  const terminalUnits = units.filter((unit) => isTerminalUnitStatus(unit.status)).length;
  // A queue job can fail after its source scan has already been finalized by a
  // concurrent batch request. Count the job failure as terminal even when the
  // source row says completed/partial, so the run cannot be reported healthy.
  const failedUnits = Math.max(units.filter((unit) => unit.status === "failed").length, jobStatuses.filter((status) => status === "failed").length);
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

function numericId(value: unknown): string | null { return typeof value === "string" && /^\d{5,30}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 10_000 ? String(value) : null; }
function isoTimestamp(value: unknown): string | null { if (typeof value !== "string") return null; const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null; }
function facebookPhotoUrl(value: unknown): string | null { if (typeof value !== "string") return null; try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.hostname === "www.facebook.com" && /^\/photo(?:\.php)?\/?$/i.test(parsed.pathname) ? value.slice(0, 2_000) : null; } catch { return null; } }
function safeDiagnosticError(value: unknown): string | null { return typeof value === "string" ? value.replace(/token|secret|cookie|hmac|authorization/gi, "redacted").slice(0, 240) : null; }
function facebookPermalink(value: unknown): string | null { if (typeof value !== "string") return null; try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.hostname === "www.facebook.com" && /\/groups\//i.test(parsed.pathname) ? value.slice(0, 2_000) : null; } catch { return null; } }
function nonnegativeInteger(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }

export function isTerminalScanStatus(status: ScanProgressStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}

export function hasActiveBackendWork(progress: Pick<ScanProgressResponse, "overall" | "facebook" | "olx">): boolean {
  return progress.overall.remainingUnits > 0
    || progress.facebook.groups.some((group) => group.status === "queued" || group.status === "running")
    || progress.olx.status === "queued"
    || progress.olx.status === "running";
}

export function hasQueuedOrRunningFacebookWork(progress: Pick<ScanProgressResponse, "facebook">): boolean {
  return progress.facebook.groups.some((group) => group.status === "queued" || group.status === "running");
}

export function collectorProgressGroupFromSourceScan(input: { id: string; status: string; scannedCount: number; errorMessage: string | null }): FacebookGroupProgress {
  return {
    groupId: "lodzsprzedazzakupwynajem",
    groupName: "Łódź sprzedaż zakup wynajem",
    jobId: `collector:${input.id}`,
    sourceScanId: input.id,
    status: input.status === "running" ? "running" : input.status === "completed" || input.status === "partial" ? "completed" : input.status === "failed" ? "failed" : "queued",
    discovered: input.scannedCount,
    processed: input.scannedCount,
    errorMessage: input.errorMessage,
  };
}

export function collectorProgressGroupFromJobAndSourceScan(input: {
  job: { id: string; sourceScanId: string | null; status: string; groupId: string | null; groupName: string | null; discovered: number; processed: number; errorMessage: string | null };
  sourceScan: { scannedCount: number; status: string; errorMessage: string | null } | null;
}): FacebookGroupProgress {
  const sourceCount = input.sourceScan?.scannedCount ?? 0;
  const sourceStatus = input.sourceScan?.status;
  const jobStatus = input.job.status === "running" ? "running" : input.job.status === "completed" || input.job.status === "partial" ? "completed" : input.job.status === "failed" ? "failed" : "queued";
  const terminalJobFailed = input.job.status === "failed";
  const terminalSourceFailed = sourceStatus === "failed";
  const status = terminalJobFailed || terminalSourceFailed ? "failed" : sourceStatus === "completed" || sourceStatus === "partial" ? "completed" : jobStatus;
  const errorMessage = (terminalJobFailed ? input.job.errorMessage ?? input.sourceScan?.errorMessage : terminalSourceFailed ? input.sourceScan?.errorMessage ?? input.job.errorMessage : null) ?? null;
  return {
    groupId: input.job.groupId,
    groupName: input.job.groupName ?? "Grupa Facebook",
    jobId: input.job.id,
    sourceScanId: input.job.sourceScanId ?? "",
    status,
    discovered: Math.max(input.job.discovered, sourceCount),
    processed: Math.max(input.job.processed, sourceCount),
    errorMessage,
  };
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
