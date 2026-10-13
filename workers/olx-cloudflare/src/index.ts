import { DurableObject } from "cloudflare:workers";
import { history, launch, limits } from "@cloudflare/playwright";

import { createApiClient } from "../../olx-browser/src/api-client.ts";
import type { WorkerConfig } from "../../olx-browser/src/config.ts";
import { currentLedger, type Ledger } from "./budget.ts";
import type { BrowserLike, BrowserProvider } from "./browser-session.ts";
import { checkCloudConfig, loadCloudConfig, parseCloudConfig, type CloudConfig } from "./config.ts";
import { createIdlePollBackoff, type IdlePollBackoff } from "../../shared/idle-poll-backoff.ts";
import { runSelfTest } from "./self-test.ts";
import { createLogger, type DiagnosticEvent } from "./logger.ts";
import { budgetLimits, nextAlarmDelayMs, runBatch, type BatchSummary } from "./runner.ts";
import { isAuthorizedAdmin } from "./admin-auth.ts";

export type Env = {
  BROWSER: Fetcher;
  OLX_RUNNER: DurableObjectNamespace<OlxCloudRunner>;
  OLX_WORKER_SECRET?: string;
  OLX_CLOUD_ADMIN_TOKEN?: string;
  [name: string]: unknown;
};

const RUNNER_NAME = "olx-runner";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEDGER_KEY = "ledger";
const DIAGNOSTICS_KEY = "diagnostics";
/** Guardrail for the optional OLX-only session (Browser Run blocks every other host). */
const OLX_ALLOWED_DOMAINS = ["olx.pl", "*.olx.pl"];

type StoredDiagnostics = {
  lastWork: (Omit<BatchSummary, "ledger"> & { at: string; trigger: string }) | null;
  lastError: { at: string; message: string } | null;
  recent: DiagnosticEvent[];
};

/**
 * The single OLX runner. One named instance guarantees one consumer: jobs are
 * never processed twice in parallel by this deployment, and the browser budget
 * ledger has one writer.
 *
 * Polling is driven by its alarm (every `OLX_CLOUD_IDLE_POLL_SECONDS` while
 * idle, ~1 s after work); the one-minute Cron Trigger only re-arms the alarm
 * if it was lost, so a delayed cron never delays a claim by a full minute.
 */
export class OlxCloudRunner extends DurableObject<Env> {
  private active: Promise<BatchSummary | null> | null = null;
  private lastPollAt: string | null = null;
  private lastCron: { at: string; scheduledTime: string; lagMs: number } | null = null;
  private backoff: IdlePollBackoff | null = null;

  async tick(scheduledTime: number): Promise<{ armed: boolean; code: string | null }> {
    const now = Date.now();
    this.lastCron = { at: new Date(now).toISOString(), scheduledTime: new Date(scheduledTime).toISOString(), lagMs: now - scheduledTime };
    const loaded = loadCloudConfig(this.env);
    // Disabled, misconfigured or manual mode: no alarm exists, so nothing is ever claimed automatically.
    if (!loaded.ok || loaded.config.claimMode !== "auto") {
      if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm();
      const code = loaded.ok ? "OLX_CLOUD_MANUAL_MODE" : loaded.code;
      console.log(JSON.stringify({ timestamp: new Date(now).toISOString(), event: "CRON_TICK_INACTIVE", code }));
      return { armed: false, code };
    }
    const alarm = await this.ctx.storage.getAlarm();
    // No alarm (first start, or lost) or an alarm overdue by >2 min (stuck): run now.
    if (alarm === null || alarm < now - 120_000) {
      await this.ctx.storage.setAlarm(now + 1_000);
      console.log(JSON.stringify({ timestamp: new Date(now).toISOString(), event: "CRON_TICK_ARMED_ALARM", previousAlarm: alarm, cronLagMs: this.lastCron.lagMs }));
    }
    return { armed: true, code: null };
  }

  async alarm(): Promise<void> {
    const loaded = loadCloudConfig(this.env);
    // Not re-armed: the cron tick arms it again once enabled in auto mode.
    if (!loaded.ok || loaded.config.claimMode !== "auto") return;
    const config = loaded.config;
    this.backoff ??= createIdlePollBackoff(config.idlePollMs, config.idlePollMaxMs);
    let delayMs = config.idlePollMs;
    try {
      if (this.active) return;
      const summary = await this.execute(config, "alarm", {});
      if (summary) {
        // Empty queue: 20 s, then 40 s (Finder's unclaimed limit is 90 s); any work resets to 20 s.
        const idleDelayMs = this.backoff.currentDelayMs();
        if (summary.outcome === "idle" || summary.outcome === "paused") this.backoff.recordEmptyClaim(); else this.backoff.recordClaimWithJob();
        delayMs = nextAlarmDelayMs(summary, config, Date.now(), idleDelayMs);
      }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    }
  }

  /**
   * On-demand claim. Manual mode (the limited trial): exactly one job, and it
   * must be a Finder job of `filterId`, otherwise it is ended untouched with
   * OLX_CLOUD_TEST_FOREIGN_JOB. Auto mode: up to `maxJobs` (1–3) of any kind.
   */
  async runOnce(maxJobs: number, filterId: string | null): Promise<{ ok: boolean; code?: string; message?: string; summary?: Omit<BatchSummary, "ledger"> & { ledger: Ledger } }> {
    const loaded = loadCloudConfig(this.env);
    if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
    if (this.active) return { ok: false, code: "OLX_CLOUD_RUNNER_BUSY", message: "Runner właśnie przetwarza zadania; spróbuj ponownie za chwilę." };
    const manual = loaded.config.claimMode === "manual";
    if (manual && !filterId) return { ok: false, code: "OLX_CLOUD_FILTER_ID_REQUIRED", message: "Tryb manual: podaj ?filterId=<uuid filtra testowego>." };
    const options = manual ? { maxJobs: 1, expectFilterId: filterId as string } : { maxJobs: Math.max(1, Math.min(3, Math.trunc(maxJobs) || 1)), ...(filterId ? { expectFilterId: filterId } : {}) };
    const summary = await this.execute(loaded.config, "run_once", options);
    return summary ? { ok: true, summary } : { ok: false, code: "OLX_CLOUD_RUN_FAILED", message: "Zobacz /status → lastError." };
  }

  /** Connectivity/HMAC check without claiming (see self-test.ts). */
  async selfTest(withBrowser: boolean): Promise<Record<string, unknown>> {
    if (this.active) return { ok: false, code: "OLX_CLOUD_RUNNER_BUSY" };
    return runSelfTest(this.env, { withBrowser, browser: browserRunProvider(this.env), ledger: {
      load: () => this.ctx.storage.get<Ledger>(LEDGER_KEY),
      save: (ledger) => this.ctx.storage.put(LEDGER_KEY, ledger),
    } });
  }

  async status(): Promise<Record<string, unknown>> {
    const loaded = loadCloudConfig(this.env);
    const diagnostics = await this.ctx.storage.get<StoredDiagnostics>(DIAGNOSTICS_KEY);
    const alarm = await this.ctx.storage.getAlarm();
    const storedLedger = await this.ctx.storage.get<Ledger>(LEDGER_KEY);
    // Shown even while the kill switch is off, so a disabled deployment can be reviewed.
    const parsed = parseCloudConfig(this.env);
    const config = parsed.ok ? publicConfig(parsed.config) : null;
    // While a batch runs its open session is live, not orphaned: show the stored ledger as is.
    const ledger = parsed.ok && !this.active ? (storedLedger ? currentLedger(storedLedger, Date.now(), budgetLimits(parsed.config)) : null) : storedLedger ?? null;
    return {
      ok: loaded.ok,
      code: loaded.ok ? null : loaded.code,
      message: loaded.ok ? null : loaded.message,
      config,
      configCheck: checkCloudConfig(this.env),
      ledger,
      browserSecondsUsedToday: ledger ? Math.round(ledger.browserMs / 1000) : null,
      paused: ledger?.stop ?? null,
      nextAlarm: alarm === null ? null : new Date(alarm).toISOString(),
      running: this.active !== null,
      lastPollAt: this.lastPollAt,
      lastCron: this.lastCron,
      lastWork: diagnostics?.lastWork ?? null,
      lastError: diagnostics?.lastError ?? null,
      recent: diagnostics?.recent ?? [],
    };
  }

  private async execute(config: CloudConfig, trigger: string, options: { maxJobs?: number; expectFilterId?: string }): Promise<BatchSummary | null> {
    const logger = createLogger();
    const run = (async () => {
      try {
        const summary = await runBatch({
          config,
          api: createApiClient({ apiUrl: config.apiUrl, secret: config.secret, workerId: config.workerId, pollIntervalMs: config.idlePollMs, once: false } satisfies WorkerConfig),
          provider: browserRunProvider(this.env),
          store: {
            load: () => this.ctx.storage.get<Ledger>(LEDGER_KEY),
            save: (ledger) => this.ctx.storage.put(LEDGER_KEY, ledger),
          },
          log: logger.log,
        }, options);
        this.lastPollAt = new Date().toISOString();
        if (summary.outcome !== "idle" || trigger !== "alarm") await this.saveDiagnostics({ lastWork: { ...withoutLedger(summary), at: this.lastPollAt, trigger } }, logger.recent());
        return summary;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.log("RUNNER_ERROR", { message });
        await this.saveDiagnostics({ lastError: { at: new Date().toISOString(), message: message.slice(0, 500) } }, logger.recent());
        return null;
      }
    })();
    this.active = run;
    try {
      return await run;
    } finally {
      this.active = null;
    }
  }

  private async saveDiagnostics(update: Partial<StoredDiagnostics>, events: DiagnosticEvent[]): Promise<void> {
    const previous = await this.ctx.storage.get<StoredDiagnostics>(DIAGNOSTICS_KEY);
    await this.ctx.storage.put(DIAGNOSTICS_KEY, {
      lastWork: update.lastWork ?? previous?.lastWork ?? null,
      lastError: update.lastError ?? previous?.lastError ?? null,
      recent: [...(previous?.recent ?? []), ...events].slice(-40),
    } satisfies StoredDiagnostics);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runner(env).tick(controller.scheduledTime));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "flip-manager-olx-cloud" });
    }
    if (url.pathname !== "/status" && url.pathname !== "/run-once" && url.pathname !== "/selftest") return new Response("Not found", { status: 404 });
    // Admin endpoints exist only when a token is configured, and never reveal whether it is.
    if (!(await isAuthorizedAdmin(request, env.OLX_CLOUD_ADMIN_TOKEN))) return new Response("Not found", { status: 404 });
    if (request.method === "GET" && url.pathname === "/status") return Response.json(await runner(env).status());
    if (request.method === "POST" && url.pathname === "/run-once") {
      const filterId = url.searchParams.get("filterId");
      if (filterId !== null && !UUID.test(filterId)) return Response.json({ ok: false, code: "OLX_CLOUD_FILTER_ID_INVALID" }, { status: 400 });
      const result = await runner(env).runOnce(Number(url.searchParams.get("maxJobs") ?? "1"), filterId);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    if (request.method === "POST" && url.pathname === "/selftest") {
      return Response.json(await runner(env).selfTest(url.searchParams.get("browser") === "1"));
    }
    return new Response("Method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<Env>;

function runner(env: Env): DurableObjectStub<OlxCloudRunner> {
  return env.OLX_RUNNER.get(env.OLX_RUNNER.idFromName(RUNNER_NAME));
}

function browserRunProvider(env: Env): BrowserProvider {
  return {
    async launch({ keepAliveMs, restrictToOlxDomains }) {
      const browser = await launch(env.BROWSER, {
        keep_alive: keepAliveMs,
        ...(restrictToOlxDomains ? { guardrails: { allowedDomains: OLX_ALLOWED_DOMAINS } } : {}),
      });
      return { browser: browser as unknown as BrowserLike, sessionId: browser.sessionId() };
    },
    limits: () => limits(env.BROWSER),
    async closedSessionDurationMs(sessionId) {
      const closed = (await history(env.BROWSER)).find((item) => item.sessionId === sessionId);
      return closed && Number.isFinite(closed.endTime - closed.startTime) ? Math.max(0, closed.endTime - closed.startTime) : null;
    },
  };
}

function withoutLedger(summary: BatchSummary): Omit<BatchSummary, "ledger"> {
  const { ledger: _ledger, ...rest } = summary;
  void _ledger;
  return rest;
}

/** Configuration echo for /status: no secret, no API host credentials. */
function publicConfig(config: CloudConfig): Record<string, unknown> {
  return {
    workerId: config.workerId,
    claimMode: config.claimMode,
    listingIdPolicy: config.listingIdPolicy,
    idlePollMaxSeconds: config.idlePollMaxMs / 1000,
    refusalPauseThreshold: config.refusalPauseThreshold,
    refusalPauseHours: config.refusalPauseMs / 3_600_000,
    apiHost: config.apiUrl.host,
    idlePollSeconds: config.idlePollMs / 1000,
    dailyBrowserLimitSeconds: config.dailyBrowserLimitMs / 1000,
    safeBrowserBudgetSeconds: config.safeBrowserBudgetMs / 1000,
    sessionMaxSeconds: config.sessionMaxMs / 1000,
    scrapeReserveSeconds: config.scrapeReserveMs / 1000,
    keepAliveSeconds: config.keepAliveMs / 1000,
    maxJobsPerDay: config.maxJobsPerDay,
    maxHeldJobs: config.maxHeldJobs,
    maxJobsPerInvocation: config.maxJobsPerInvocation,
    onBudgetExhausted: config.onBudgetExhausted,
    blockHeavyResources: config.blockHeavyResources,
    pageJavaScript: config.pageJavaScript,
    restrictToOlxDomains: config.restrictToOlxDomains,
  };
}
