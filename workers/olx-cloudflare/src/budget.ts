/**
 * Daily Browser Run budget ledger.
 *
 * Cloudflare Workers Free allows 10 minutes of browser time per UTC day and
 * answers HTTP 429 once it is spent. We keep our own ledger (persisted in the
 * Durable Object) and stop well before the plan limit so a measurement error
 * never turns into a hard 429 in the middle of a scan.
 *
 * Time is charged from just before a session is acquired until its close
 * completed. When Cloudflare reports a longer server-side duration for the
 * same session (`history()`), the longer value wins.
 */

export type BudgetStop = {
  code: BudgetStopCode;
  message: string;
  at: string;
  resumesAt: string;
};

export type BudgetStopCode =
  | "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED"
  | "OLX_CLOUD_BROWSER_DAILY_LIMIT_429"
  | "OLX_CLOUD_DAILY_JOB_CAP_REACHED"
  | "OLX_CLOUD_OLX_ACCESS_PAUSED";

export type Ledger = {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  browserMs: number;
  sessions: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  /** Jobs claimed only to be failed with a budget diagnostic (not counted against the job cap). */
  jobsRejected: number;
  /** Consecutive OLX refusals (403/405/429/verification); reset by any normal page. */
  refusalStreak: number;
  /** A session that was open when this runner last persisted; charged on recovery. */
  openSession: { startedAt: number; sessionId: string | null } | null;
  stop: BudgetStop | null;
};

export type BudgetLimits = {
  dailyBrowserLimitMs: number;
  safeBrowserBudgetMs: number;
  scrapeReserveMs: number;
  sessionMaxMs: number;
  keepAliveMs: number;
  maxJobsPerDay: number;
};

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

export function emptyLedger(now: number): Ledger {
  return { day: utcDay(now), browserMs: 0, sessions: 0, jobsClaimed: 0, jobsCompleted: 0, jobsFailed: 0, jobsRejected: 0, refusalStreak: 0, openSession: null, stop: null };
}

/**
 * Returns the ledger valid for `now`. A new UTC day starts from zero (that is
 * when Cloudflare resets the allowance). A session left open by a runner that
 * died is charged at its worst case: until `keep_alive` closed it.
 */
export function currentLedger(stored: Ledger | null | undefined, now: number, limits: BudgetLimits): Ledger {
  let ledger: Ledger = stored && isLedger(stored) ? { ...emptyLedger(now), ...stored } : emptyLedger(now);
  if (ledger.openSession) {
    // Open until the runner died (at most sessionMax), then idle until keep_alive.
    const orphanMs = Math.min(Math.max(0, now - ledger.openSession.startedAt), limits.sessionMaxMs) + limits.keepAliveMs;
    ledger = { ...ledger, browserMs: ledger.browserMs + orphanMs, openSession: null };
  }
  if (ledger.day !== utcDay(now)) {
    // A new UTC day resets Cloudflare's allowance, not an OLX access pause.
    const carried = ledger.stop?.code === "OLX_CLOUD_OLX_ACCESS_PAUSED" && Date.parse(ledger.stop.resumesAt) > now ? ledger.stop : null;
    ledger = { ...emptyLedger(now), stop: carried, refusalStreak: carried ? ledger.refusalStreak : 0 };
  }
  return ledger;
}

/** Browser time used today, including the session currently open (if any). */
export function spentMs(ledger: Ledger, now: number, openSessionStartedAt: number | null): number {
  return ledger.browserMs + (openSessionStartedAt === null ? 0 : Math.max(0, now - openSessionStartedAt));
}

export function remainingSafeMs(ledger: Ledger, now: number, openSessionStartedAt: number | null, limits: BudgetLimits): number {
  return Math.max(0, limits.safeBrowserBudgetMs - spentMs(ledger, now, openSessionStartedAt));
}

/** Whether one more OLX page may be opened without crossing the safe budget. */
export function canScrape(ledger: Ledger, now: number, openSessionStartedAt: number | null, limits: BudgetLimits): boolean {
  if (hardStop(ledger, now)) return false;
  return remainingSafeMs(ledger, now, openSessionStartedAt, limits) >= limits.scrapeReserveMs;
}

/** A stop that no configuration change lifts: Cloudflare's 429 (until UTC midnight) or an active OLX access pause. */
export function hardStop(ledger: Ledger, now: number): BudgetStop | null {
  const stop = ledger.stop;
  if (!stop) return null;
  if (stop.code === "OLX_CLOUD_BROWSER_DAILY_LIMIT_429") return stop;
  if (stop.code === "OLX_CLOUD_OLX_ACCESS_PAUSED" && Date.parse(stop.resumesAt) > now) return stop;
  return null;
}

export function jobCapReached(ledger: Ledger, limits: BudgetLimits): boolean {
  return limits.maxJobsPerDay > 0 && ledger.jobsClaimed >= limits.maxJobsPerDay;
}

/** Automatic pause after OLX refused access repeatedly: nothing is fetched until `resumesAt`. */
export function accessPauseStop(ledger: Ledger, now: number, pauseMs: number, lastCode: string): BudgetStop {
  const resumesAt = new Date(now + pauseMs).toISOString();
  return {
    code: "OLX_CLOUD_OLX_ACCESS_PAUSED",
    message: `OLX odmówił dostępu ${ledger.refusalStreak} razy z rzędu (ostatnio ${lastCode}). Pobieranie OLX z Cloudflare wstrzymane do ${resumesAt}; zabezpieczenia OLX nie są obchodzone.`,
    at: new Date(now).toISOString(),
    resumesAt,
  };
}

export function budgetStop(code: BudgetStopCode, ledger: Ledger, now: number, limits: BudgetLimits): BudgetStop {
  const used = Math.round(ledger.browserMs / 1_000);
  const safe = Math.round(limits.safeBrowserBudgetMs / 1_000);
  const plan = Math.round(limits.dailyBrowserLimitMs / 1_000);
  const resumesAt = nextUtcMidnight(now);
  const message = code === "OLX_CLOUD_DAILY_JOB_CAP_REACHED"
    ? `Cloudflare OLX: osiągnięto dzienny limit zadań (${ledger.jobsClaimed}/${limits.maxJobsPerDay}). Wznowienie ${resumesAt}.`
    : code === "OLX_CLOUD_BROWSER_DAILY_LIMIT_429"
      ? `Cloudflare Browser Run odrzucił sesję (HTTP 429 — dzienny limit planu ${plan} s wyczerpany po stronie Cloudflare; licznik workera: ${used} s). Pobieranie OLX wstrzymane do ${resumesAt}.`
      : `Cloudflare Browser Run: osiągnięto bezpieczny dzienny budżet przeglądarki (zużyto ${used} s z ${safe} s; limit planu ${plan} s). Pobieranie OLX wstrzymane do ${resumesAt}.`;
  return { code, message, at: new Date(now).toISOString(), resumesAt };
}

function isLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.day === "string" && typeof row.browserMs === "number" && Number.isFinite(row.browserMs);
}
