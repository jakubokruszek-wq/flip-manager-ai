import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { finderOlxSharedDailyJobBudget, isFinderOlxIntervalMinutes } from "@/features/flip-finder/finder-schedule";
import { activeSources, slugifyCity } from "@/features/flip-finder/server/search-source-registry";
import { getOlxAutomationStatus, type OlxAutomationStatus } from "@/features/flip-finder/server/olx-scheduled-claim";
import type { SupabaseClient as DatabaseClient } from "@supabase/supabase-js";

/**
 * Automatic OLX schedule of Finder (docs/finder-olx-schedule.md).
 *
 * OLX is no longer queued by the portals' cycle (finder_scan_interval_minutes,
 * e.g. 300 min). Every scheduler tick (pg_cron, every 5 min) asks the database
 * function enqueue_scheduled_finder_olx_job, which alone decides -- under one
 * global advisory lock, from durable rows and the database clock -- whether
 * an automatic OLX job may be queued: the filter's own OLX interval (24/48/72
 * h, counted from when its last OLX job was ORDERED), at most one automatic
 * Finder OLX job per rolling 24 h for all filters, and the shared OLX budget
 * that also counts manual Finder and Price Radar jobs. Any failure, missing
 * migration or unreadable interval means "queue nothing" (fail closed).
 */

const OLX_SCHEDULE_DB_TIMEOUT_MS = 5_000;

export type FinderOlxScheduleReason =
  | "FILTER_NOT_FOUND"
  | "FILTER_INACTIVE"
  | "OLX_NOT_SELECTED"
  | "OLX_JOB_IN_FLIGHT"
  | "OLX_INTERVAL_NOT_ELAPSED"
  | "AUTOMATIC_DAILY_BUDGET_USED"
  | "SHARED_DAILY_BUDGET_USED"
  | "ANOTHER_FILTER_FIRST"
  | "BROWSER_BUDGET_INSUFFICIENT"
  | "AUTOMATION_DISABLED"
  | "BEFORE_FIRST_SLOT"
  | "SLOT_ALREADY_HANDLED"
  | "SLOT_MISSED"
  | "OLX_INTERVAL_UNAVAILABLE"
  | "OLX_SCHEDULE_UNAVAILABLE"
  | "OLX_SCHEDULE_CHECK_FAILED";

export type FinderOlxScheduleDecision = {
  filterId: string;
  /** enqueued: a job was queued now; due: dry run, a job would be queued; skipped: see reason. */
  decision: "enqueued" | "due" | "skipped";
  reason: FinderOlxScheduleReason | null;
  checkedAt: string | null;
  intervalMinutes: number | null;
  jobId: string | null;
  runId: string | null;
  lastJobAt: string | null;
  lastJobStatus: string | null;
  lastJobAutomatic: boolean;
  nextAllowedAt: string | null;
  /** Slot schedule (migration 20261016120000); null with the older decision function. */
  schedule: {
    startTime: string | null;
    timeZone: string | null;
    slotAt: string | null;
    slotLocal: string | null;
    nextSlotAt: string | null;
    nextSlotLocal: string | null;
    graceUntil: string | null;
    /** Why a slot that is still open has to wait (in-flight, budget, fairness). */
    blocker: string | null;
    lastSlot: {
      slotAt: string | null; status: string | null; reason: string | null; jobStatus: string | null; jobErrorCode: string | null;
      startedAt: string | null; finishedAt: string | null; workerId: string | null; delaySeconds: number | null;
    } | null;
  } | null;
  /** Latest Browser Run usage reported today by the scheduled Worker (null = no report today). */
  browserBudget: { accountBrowserMs: number | null; safeBudgetMs: number | null; jobEstimateMs: number | null; remainingMs: number | null; fitsOneJob: boolean | null; reportedAt: string | null } | null;
  budget: {
    windowHours: 24;
    automaticJobs: number | null;
    automaticLimit: number;
    finderOtherJobs: number | null;
    radarJobs: number | null;
    cloudflareJobs: number | null;
    totalJobs: number | null;
    sharedLimit: number;
  } | null;
};

/**
 * Only a missing database function ends the tick for every filter. Budget
 * reasons do not: each filter's open slot must still be evaluated so that a
 * slot past its grace is recorded as missed (with its cause) exactly once.
 */
const GLOBAL_REASONS: ReadonlySet<FinderOlxScheduleReason> = new Set(["OLX_SCHEDULE_UNAVAILABLE"]);

export const FINDER_OLX_SCHEDULE_REASON_LABELS: Record<FinderOlxScheduleReason, string> = {
  FILTER_NOT_FOUND: "filtr nie istnieje",
  FILTER_INACTIVE: "filtr jest wstrzymany",
  OLX_NOT_SELECTED: "OLX nie jest wybrany w filtrze",
  OLX_JOB_IN_FLIGHT: "poprzednie zadanie OLX tego filtra wciąż czeka lub trwa",
  OLX_INTERVAL_NOT_ELAPSED: "nie minął interwał OLX od ostatniego zlecenia",
  AUTOMATIC_DAILY_BUDGET_USED: "wykorzystany globalny limit automatycznych skanów OLX na 24 h (wszystkie filtry)",
  SHARED_DAILY_BUDGET_USED: "wykorzystany wspólny budżet OLX na 24 h (razem z ręcznymi skanami Findera)",
  BROWSER_BUDGET_INSUFFICIENT: "brak dziennego budżetu przeglądarki Cloudflare na kolejne zadanie (wg zużycia zgłoszonego przez Workera)",
  AUTOMATION_DISABLED: "automat OLX wyłączony (STOP): termin nie jest zlecany, bo żaden Worker by go nie odebrał",
  BEFORE_FIRST_SLOT: "pierwszy termin nowego harmonogramu jeszcze nie nadszedł",
  SLOT_ALREADY_HANDLED: "bieżący termin już obsłużono",
  SLOT_MISSED: "termin pominięty: nie udało się zlecić w czasie tolerancji (bez nadrabiania)",
  ANOTHER_FILTER_FIRST: "pierwszeństwo ma inny filtr z OLX, który czeka dłużej",
  OLX_INTERVAL_UNAVAILABLE: "brak odczytu interwału OLX (migracja niezastosowana?)",
  OLX_SCHEDULE_UNAVAILABLE: "brak funkcji harmonogramu OLX w bazie (migracja niezastosowana)",
  OLX_SCHEDULE_CHECK_FAILED: "błąd sprawdzenia limitu OLX; nic nie zlecono",
};

export function filterUsesOlx(filter: SearchFilter): boolean {
  return activeSources(filter).some((source) => source.id === "olx");
}

export function sharedDailyJobBudget(): number {
  return finderOlxSharedDailyJobBudget(process.env.FINDER_OLX_SHARED_DAILY_JOB_BUDGET);
}

export async function scheduleFinderOlxJob(
  supabase: DatabaseClient,
  filter: SearchFilter,
  options: { dryRun?: boolean; runId?: string; sharedLimit?: number } = {},
): Promise<FinderOlxScheduleDecision> {
  const sharedLimit = options.sharedLimit ?? sharedDailyJobBudget();
  if (!isFinderOlxIntervalMinutes(filter.finderOlxScanIntervalMinutes)) return skipped(filter.id, "OLX_INTERVAL_UNAVAILABLE", sharedLimit);
  const requestUrl = `https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/${slugifyCity(filter.city)}/`;
  assertAllowedOlxUrl(requestUrl);
  let result: { data: unknown; error: { code?: string; message?: string } | null };
  try {
    result = await supabase.rpc("enqueue_scheduled_finder_olx_job", {
      p_filter_id: filter.id,
      p_run_id: options.runId ?? crypto.randomUUID(),
      p_request_url: requestUrl,
      p_filter_snapshot: filter,
      p_shared_limit: sharedLimit,
      p_dry_run: options.dryRun ?? false,
    }).abortSignal(AbortSignal.timeout(OLX_SCHEDULE_DB_TIMEOUT_MS));
  } catch (error) {
    console.warn("FINDER_OLX_SCHEDULE_CHECK_FAILED", { filterId: filter.id, detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return skipped(filter.id, "OLX_SCHEDULE_CHECK_FAILED", sharedLimit);
  }
  if (result.error) {
    const missing = result.error.code === "PGRST202" || result.error.code === "42883";
    console.warn("FINDER_OLX_SCHEDULE_CHECK_FAILED", { filterId: filter.id, code: result.error.code ?? null, detail: (result.error.message ?? "").slice(0, 200) });
    return skipped(filter.id, missing ? "OLX_SCHEDULE_UNAVAILABLE" : "OLX_SCHEDULE_CHECK_FAILED", sharedLimit);
  }
  return parseDecision(filter.id, result.data, sharedLimit);
}

export type FinderOlxSchedulerPhase = { decisions: FinderOlxScheduleDecision[]; enqueued: number };

/**
 * One tick of the automatic OLX schedule. At most one job per tick; a missing
 * decision function ends the tick for every filter.
 * Never throws: OLX must not stop the other portals' cycle.
 */
export async function runFinderOlxSchedulerPhase(
  filters: readonly SearchFilter[],
  schedule: (filter: SearchFilter) => Promise<FinderOlxScheduleDecision>,
): Promise<FinderOlxSchedulerPhase> {
  const phase: FinderOlxSchedulerPhase = { decisions: [], enqueued: 0 };
  for (const filter of filters.filter((item) => item.isActive && filterUsesOlx(item))) {
    let decision: FinderOlxScheduleDecision;
    try {
      decision = await schedule(filter);
    } catch (error) {
      console.warn("FINDER_OLX_SCHEDULE_CHECK_FAILED", { filterId: filter.id, detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      decision = skipped(filter.id, "OLX_SCHEDULE_CHECK_FAILED", sharedDailyJobBudget());
    }
    phase.decisions.push(decision);
    console.info("FINDER_OLX_SCHEDULER_DECISION", {
      filterId: filter.id,
      decision: decision.decision,
      reason: decision.reason,
      jobId: decision.jobId,
      runId: decision.runId,
      lastJobAt: decision.lastJobAt,
      nextAllowedAt: decision.nextAllowedAt,
      budget: decision.budget,
    });
    if (decision.decision === "enqueued") {
      phase.enqueued += 1;
      break;
    }
    if (decision.reason && GLOBAL_REASONS.has(decision.reason)) break;
  }
  return phase;
}

/**
 * Readable text of the separate OLX schedule's decision (scheduler diagnostics).
 * Since 14.10.2026 it is never added to a portals' run: OLX is not a Finder stage.
 */
export function olxScheduleNote(decision: Pick<FinderOlxScheduleDecision, "decision" | "reason" | "runId" | "nextAllowedAt"> | undefined): string {
  if (!decision) return "olx: OLX_SEPARATE_SCHEDULE: OLX ma osobny harmonogram; w tym cyklu nie sprawdzono kolejki OLX.";
  if (decision.decision === "enqueued") return `olx: OLX_SCHEDULED: zlecono automatyczny skan OLX (przebieg ${decision.runId}).`;
  const reason = decision.reason ? FINDER_OLX_SCHEDULE_REASON_LABELS[decision.reason] : "brak powodu";
  const next = decision.nextAllowedAt ? `; następny dopuszczalny termin: ${decision.nextAllowedAt}` : "";
  if (decision.reason === "SLOT_ALREADY_HANDLED" || decision.reason === "BEFORE_FIRST_SLOT") return `olx: OLX_SCHEDULED_SLOT: ${FINDER_OLX_SCHEDULE_REASON_LABELS[decision.reason]}${next}.`;
  return `olx: OLX_SKIPPED_${decision.reason ?? "UNKNOWN"}: ${reason}${next}.`;
}

function skipped(filterId: string, reason: FinderOlxScheduleReason, sharedLimit: number): FinderOlxScheduleDecision {
  return {
    filterId, decision: "skipped", reason, checkedAt: null, intervalMinutes: null, jobId: null, runId: null,
    lastJobAt: null, lastJobStatus: null, lastJobAutomatic: false, nextAllowedAt: null, schedule: null, browserBudget: null,
    budget: { windowHours: 24, automaticJobs: null, automaticLimit: 1, finderOtherJobs: null, radarJobs: null, cloudflareJobs: null, totalJobs: null, sharedLimit },
  };
}

const KNOWN_REASONS = new Set<string>(Object.keys(FINDER_OLX_SCHEDULE_REASON_LABELS));

/** Anything unexpected in the database answer is treated as "do not queue". */
export function parseDecision(filterId: string, value: unknown, sharedLimit: number): FinderOlxScheduleDecision {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const decision = row?.decision;
  const reason = row?.reason;
  if (!row || (decision !== "enqueued" && decision !== "due" && decision !== "skipped")
    || (decision === "skipped" ? typeof reason !== "string" || !KNOWN_REASONS.has(reason) : reason !== null)
    || (decision === "enqueued" && typeof row.job_id !== "string")) {
    return skipped(filterId, "OLX_SCHEDULE_CHECK_FAILED", sharedLimit);
  }
  const text = (key: string) => typeof row[key] === "string" ? row[key] as string : null;
  const count = (key: string) => typeof row[key] === "number" && Number.isInteger(row[key]) ? row[key] as number : null;
  return {
    filterId,
    decision,
    reason: decision === "skipped" ? reason as FinderOlxScheduleReason : null,
    checkedAt: text("checked_at"),
    intervalMinutes: count("interval_minutes"),
    jobId: text("job_id"),
    runId: text("run_id"),
    lastJobAt: text("last_job_at"),
    lastJobStatus: text("last_job_status"),
    lastJobAutomatic: row.last_job_automatic === true,
    nextAllowedAt: text("next_allowed_at"),
    schedule: parseSchedule(row),
    browserBudget: parseBrowserBudget(row.browser_budget),
    budget: {
      windowHours: 24,
      automaticJobs: count("automatic_jobs_in_window"),
      automaticLimit: count("automatic_limit") ?? 1,
      finderOtherJobs: count("finder_other_jobs_in_window"),
      radarJobs: count("radar_jobs_in_window"),
      cloudflareJobs: count("cloudflare_jobs_in_window"),
      totalJobs: count("total_jobs_in_window"),
      sharedLimit: count("shared_limit") ?? sharedLimit,
    },
  };
}

export type FinderOlxScheduleStatus = FinderOlxScheduleDecision & {
  olxSelected: boolean;
  /** Unattended OLX (scheduled Cloudflare Worker): database switch and last automatic jobs. */
  automation: OlxAutomationStatus | null;
  /** Browser seconds are counted only inside the Cloudflare Worker (Durable Object ledger, GET /status). */
  cloudflareBrowserSeconds: null;
};

/** Read-only diagnostics for the filter settings: a dry run of the same database decision. */
export async function getFinderOlxScheduleStatus(supabase: DatabaseClient, filter: SearchFilter): Promise<FinderOlxScheduleStatus> {
  const [decision, automation] = await Promise.all([
    scheduleFinderOlxJob(supabase, filter, { dryRun: true }),
    getOlxAutomationStatus(supabase).catch(() => null),
  ]);
  return { ...decision, olxSelected: filterUsesOlx(filter), automation, cloudflareBrowserSeconds: null };
}

function parseSchedule(row: Record<string, unknown>): FinderOlxScheduleDecision["schedule"] {
  if (!("slot_at" in row) && !("start_time" in row)) return null;
  const text = (source: Record<string, unknown>, key: string) => typeof source[key] === "string" ? source[key] as string : null;
  const last = row.last_slot && typeof row.last_slot === "object" && !Array.isArray(row.last_slot) ? row.last_slot as Record<string, unknown> : null;
  return {
    startTime: text(row, "start_time"), timeZone: text(row, "time_zone"), slotAt: text(row, "slot_at"), slotLocal: text(row, "slot_local"),
    nextSlotAt: text(row, "next_slot_at"), nextSlotLocal: text(row, "next_slot_local"), graceUntil: text(row, "grace_until"), blocker: text(row, "blocker"),
    lastSlot: last ? {
      slotAt: text(last, "slot_at"), status: text(last, "status"), reason: text(last, "reason"), jobStatus: text(last, "job_status"), jobErrorCode: text(last, "job_error_code"),
      startedAt: text(last, "started_at"), finishedAt: text(last, "finished_at"), workerId: text(last, "worker_id"),
      delaySeconds: typeof last.delay_seconds === "number" && Number.isFinite(last.delay_seconds) ? last.delay_seconds : null,
    } : null,
  };
}

function parseBrowserBudget(value: unknown): FinderOlxScheduleDecision["browserBudget"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const number = (key: string) => typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] as number : null;
  return {
    accountBrowserMs: number("account_browser_ms"), safeBudgetMs: number("safe_budget_ms"), jobEstimateMs: number("job_estimate_ms"),
    remainingMs: number("remaining_ms"), fitsOneJob: typeof row.fits_one_job === "boolean" ? row.fits_one_job : null,
    reportedAt: typeof row.reported_at === "string" ? row.reported_at : null,
  };
}
