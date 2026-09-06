type CollectorImageRule = {
  id: number | null;
  priority: number | null;
  actionType: string | null;
  condition: {
    tabIds: number[];
    resourceTypes: string[];
    urlFilter?: string;
    regexFilter?: string;
    requestDomains?: string[];
    initiatorDomains?: string[];
  };
};

type CollectorImageRuleOptions = {
  removeRuleIds: number[];
  addRules: CollectorImageRule[];
};

type CollectorImageRuleDiagnostics = {
  tabId: number | null;
  ruleIds: number[];
  chromeErrorName: string | null;
  chromeErrorMessage: string | null;
  options: CollectorImageRuleOptions | null;
};

export type CollectorScanFailure = {
  errorCode: string;
  stage: string | null;
  query: string | null;
  tabId: number | null;
  elapsedMs: number | null;
  source: string | null;
  imageRule: CollectorImageRuleDiagnostics | null;
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
    imageRule: safeImageRuleDiagnostics(value.imageRule),
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
      ...(input.imageRule ? { imageRule: input.imageRule } : {}),
    }].slice(-100),
  };
}

function safeImageRuleDiagnostics(value: unknown): CollectorImageRuleDiagnostics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const options = safeRuleUpdate(source.options);
  const tabId = safeInteger(source.tabId);
  const ruleIds = safeIntegerArray(source.ruleIds, 10);
  const chromeErrorName = safeText(source.chromeErrorName, 120);
  const chromeErrorMessage = safeText(source.chromeErrorMessage, 400);
  if (tabId === null && !ruleIds.length && !chromeErrorName && !chromeErrorMessage && !options) return null;
  return { tabId, ruleIds, chromeErrorName, chromeErrorMessage, options };
}

function safeRuleUpdate(value: unknown): CollectorImageRuleOptions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const addRules = Array.isArray(source.addRules) ? source.addRules.map(safeRule).filter((rule): rule is NonNullable<ReturnType<typeof safeRule>> => rule !== null).slice(0, 10) : [];
  const removeRuleIds = safeIntegerArray(source.removeRuleIds, 20);
  if (!addRules.length && !removeRuleIds.length) return null;
  return { removeRuleIds, addRules };
}

function safeRule(value: unknown): CollectorImageRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const conditionValue = source.condition;
  if (!conditionValue || typeof conditionValue !== "object" || Array.isArray(conditionValue)) return null;
  const condition = conditionValue as Record<string, unknown>;
  const safeCondition: CollectorImageRule["condition"] = {
    tabIds: safeIntegerArray(condition.tabIds, 20),
    resourceTypes: safeStringArray(condition.resourceTypes, 20, 80),
  };
  for (const key of ["urlFilter", "regexFilter"] as const) {
    const text = safeText(condition[key], 500);
    if (text) safeCondition[key] = text;
  }
  for (const key of ["requestDomains", "initiatorDomains"] as const) {
    const values = safeStringArray(condition[key], 20, 120);
    if (values.length) safeCondition[key] = values;
  }
  return {
    id: safeInteger(source.id),
    priority: safeInteger(source.priority),
    actionType: source.actionType === null || typeof source.actionType === "string" ? (source.actionType as string | null) : null,
    condition: safeCondition,
  };
}

function safeIntegerArray(value: unknown, maxLength: number): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0).slice(0, maxLength) : [];
}

function safeStringArray(value: unknown, maxLength: number, itemLength: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, itemLength)).slice(0, maxLength) : [];
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
