/**
 * Configuration of the Cloudflare (Workers Free + Browser Run) OLX worker.
 *
 * Every value comes from `wrangler.toml` [vars] or `wrangler secret put`.
 * Nothing secret has a default. Parsing never throws into the scheduler: an
 * invalid configuration is reported as a diagnostic and no job is claimed.
 */

export type BudgetExhaustedPolicy = "fail_jobs" | "leave_queued";

export type CloudConfig = {
  enabled: boolean;
  apiUrl: URL;
  secret: string;
  workerId: string;
  /** Idle claim interval driven by the Durable Object alarm. */
  idlePollMs: number;
  /** Cloudflare's own daily Browser Run allowance on the current plan. */
  dailyBrowserLimitMs: number;
  /** Our self-imposed ceiling, kept below the plan allowance. */
  safeBrowserBudgetMs: number;
  /** One browser session is closed once it is this old (it is reopened on demand). */
  sessionMaxMs: number;
  /** Browser time reserved before a single OLX page is opened. */
  scrapeReserveMs: number;
  /** Browser Run `keep_alive`: how long an orphaned session survives without CDP traffic. */
  keepAliveMs: number;
  /** 0 = no cap. Used for the limited production trial. */
  maxJobsPerDay: number;
  /** Jobs held (claimed with a live lease) at the same time by one runner. */
  maxHeldJobs: number;
  /**
   * Jobs claimed by one alarm invocation. Workers Free gives an invocation
   * ~10 ms of CPU and each job costs ~3–5 ms (CDP traffic, HMAC of the
   * ~300 kB completion), so the default is 2; the next alarm follows ~1 s later.
   */
  maxJobsPerInvocation: number;
  onBudgetExhausted: BudgetExhaustedPolicy;
  blockHeavyResources: boolean;
  /**
   * Run OLX's own page scripts. Off by default: PRERENDERED_STATE and the
   * listing cards are in the server-rendered HTML, and without page scripts the
   * session makes a handful of requests instead of dozens (less browser time,
   * less CDP traffic for the Worker to process). A challenge page is detected
   * and reported either way; it is never worked around.
   */
  pageJavaScript: boolean;
  /** Optional Browser Run guardrail limiting the session to OLX hostnames. */
  restrictToOlxDomains: boolean;
};

export type ConfigResult = { ok: true; config: CloudConfig } | { ok: false; code: "OLX_CLOUD_CONFIG_INVALID" | "OLX_CLOUD_DISABLED"; message: string };

type Environment = Record<string, unknown>;

/** Cloudflare's documented Workers Free allowance: 10 minutes of Browser Run per UTC day. */
export const FREE_PLAN_DAILY_BROWSER_MS = 600_000;

export function loadCloudConfig(environment: Environment): ConfigResult {
  if (stringValue(environment.OLX_CLOUD_ENABLED) !== "1") {
    return { ok: false, code: "OLX_CLOUD_DISABLED", message: "OLX_CLOUD_ENABLED nie jest ustawione na \"1\" — worker nie odbiera zadań." };
  }
  try {
    const apiUrl = new URL(required(environment, "OLX_WORKER_API_URL"));
    if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost" && apiUrl.hostname !== "127.0.0.1") throw new Error("OLX_WORKER_API_URL must use HTTPS.");
    const secret = required(environment, "OLX_WORKER_SECRET");
    if (secret.length < 32) throw new Error("OLX_WORKER_SECRET must contain at least 32 characters.");
    const workerId = (stringValue(environment.OLX_CLOUD_WORKER_ID) || "cloudflare-olx-1").slice(0, 100);
    if (workerId.length < 3) throw new Error("OLX_CLOUD_WORKER_ID must contain at least 3 characters.");

    const dailyBrowserLimitMs = seconds(environment, "OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS", 600, 60, 86_400);
    const safeBrowserBudgetMs = seconds(environment, "OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS", 480, 30, 86_400);
    if (safeBrowserBudgetMs > dailyBrowserLimitMs) throw new Error("OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS cannot exceed OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS.");
    const sessionMaxMs = seconds(environment, "OLX_CLOUD_SESSION_MAX_SECONDS", 45, 15, 300);
    const scrapeReserveMs = seconds(environment, "OLX_CLOUD_SCRAPE_RESERVE_SECONDS", 35, 10, 120);
    if (scrapeReserveMs > safeBrowserBudgetMs) throw new Error("OLX_CLOUD_SCRAPE_RESERVE_SECONDS cannot exceed the safe budget.");
    // 90 s is Finder's unclaimed-job watchdog. The idle interval must leave room
    // for the claim round trip and a delayed alarm, hence the 45 s ceiling.
    const idlePollMs = seconds(environment, "OLX_CLOUD_IDLE_POLL_SECONDS", 20, 10, 45);
    const keepAliveMs = seconds(environment, "OLX_CLOUD_KEEP_ALIVE_SECONDS", 20, 10, 60);
    const maxJobsPerDay = integer(environment, "OLX_CLOUD_MAX_JOBS_PER_DAY", 0, 0, 10_000);
    const maxHeldJobs = integer(environment, "OLX_CLOUD_MAX_HELD_JOBS", 2, 1, 5);
    const maxJobsPerInvocation = integer(environment, "OLX_CLOUD_MAX_JOBS_PER_INVOCATION", 2, 1, 10);
    const policy = stringValue(environment.OLX_CLOUD_ON_BUDGET_EXHAUSTED) || "fail_jobs";
    if (policy !== "fail_jobs" && policy !== "leave_queued") throw new Error("OLX_CLOUD_ON_BUDGET_EXHAUSTED must be fail_jobs or leave_queued.");
    return {
      ok: true,
      config: {
        enabled: true, apiUrl, secret, workerId, idlePollMs, dailyBrowserLimitMs, safeBrowserBudgetMs, sessionMaxMs, scrapeReserveMs, keepAliveMs,
        maxJobsPerDay, maxHeldJobs, maxJobsPerInvocation, onBudgetExhausted: policy,
        blockHeavyResources: stringValue(environment.OLX_CLOUD_BLOCK_HEAVY_RESOURCES) !== "0",
        pageJavaScript: stringValue(environment.OLX_CLOUD_PAGE_JAVASCRIPT) === "1",
        restrictToOlxDomains: stringValue(environment.OLX_CLOUD_RESTRICT_TO_OLX_DOMAINS) === "1",
      },
    };
  } catch (error) {
    // Never echo values: the message names the variable, not its content.
    return { ok: false, code: "OLX_CLOUD_CONFIG_INVALID", message: error instanceof Error ? error.message : "Invalid configuration." };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function required(environment: Environment, name: string): string {
  const value = stringValue(environment[name]);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function integer(environment: Environment, name: string, fallback: number, min: number, max: number): number {
  const raw = stringValue(environment[name]);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function seconds(environment: Environment, name: string, fallback: number, min: number, max: number): number {
  return integer(environment, name, fallback, min, max) * 1_000;
}
