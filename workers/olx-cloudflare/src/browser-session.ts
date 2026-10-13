import { assertAllowedOlxUrl } from "../../../features/flip-finder/olx-parser.ts";
import { ControlledOlxFailure } from "../../olx-browser/src/retry.ts";
import { inPageExpression } from "./in-page-expression.ts";
import { decodeInPageResult, isParserError, type InPageOptions, type OlxVerification } from "./olx-page.ts";
import type { ListingFixReport } from "./listing-fixes.ts";
import { rawListings } from "./raw-listings.ts";

/**
 * The subset of the Playwright API used here. `@cloudflare/playwright` (Browser
 * Run) and regular `playwright` (the local stand-in used by the integration
 * tests) both satisfy it.
 */
export type BrowserLike = {
  newContext(options?: { locale?: string; javaScriptEnabled?: boolean }): Promise<ContextLike>;
  close(): Promise<void>;
};
export type ContextLike = {
  newPage(): Promise<PageLike>;
  newCDPSession?(page: PageLike): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown> }>;
  close(): Promise<void>;
};
export type PageLike = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number; ok(): boolean } | null>;
  evaluate(expression: string): Promise<unknown>;
};

export type BrowserLimits = { allowedBrowserAcquisitions: number; timeUntilNextAllowedBrowserAcquisition: number };

export type BrowserProvider = {
  launch(options: { keepAliveMs: number; restrictToOlxDomains: boolean }): Promise<{ browser: BrowserLike; sessionId: string | null }>;
  /** Browser Run acquisition limits (1 new browser per 20 s on Free). Optional in tests. */
  limits?(): Promise<BrowserLimits>;
  /** Server-side duration of a closed session, when Cloudflare reports it. */
  closedSessionDurationMs?(sessionId: string): Promise<number | null>;
};

export type SessionHooks = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
  /** Count one outbound subrequest against the invocation's Free-plan allowance. */
  countSubrequest(kind: string): void;
  /** Called before opening each page; throws a ControlledOlxFailure when the budget forbids it. */
  assertBudget(openSessionStartedAt: number | null): void;
  onSessionOpened(startedAt: number, sessionId: string | null): Promise<void>;
  onSessionClosed(chargedMs: number, sessionId: string | null): Promise<void>;
  /** Browser Run refused the session (HTTP 429) although acquisitions were allowed: the daily allowance is gone. */
  onDailyLimitRejected(): Promise<void>;
  /** OLX refused access (HTTP 403/405/429 or a verification page): feeds the automatic pause. */
  onOlxRefused(code: string): Promise<void>;
  /** OLX served a normal page: resets the refusal streak. */
  onOlxAccepted(): Promise<void>;
};

export type ScrapeResult = {
  diagnostics: { status: number | null; finalUrl: string; title: string; bodyLength: number; marker: boolean; challenge: boolean; stateSource: string | null; browserMs: number };
  rawItems: number;
  normalizedItems: number;
  listings: unknown[];
  warnings: string[];
  durationMs: number;
  verification: OlxVerification | null;
  fixReport: ListingFixReport | null;
};

const GOTO_TIMEOUT_MS = 30_000;
const MAX_ACQUIRE_WAIT_MS = 25_000;
/** Images, media and fonts are irrelevant for PRERENDERED_STATE and cost browser time. */
const BLOCKED_URL_PATTERNS = [
  "*.jpg*", "*.jpeg*", "*.png*", "*.webp*", "*.gif*", "*.avif*", "*.svg*", "*.ico*",
  "*.woff*", "*.ttf*", "*.otf*", "*.mp4*", "*.webm*",
  "*apollo.olxcdn.com*", "*googletagmanager.com*", "*google-analytics.com*", "*doubleclick.net*", "*facebook.net*", "*hotjar.com*",
];

/**
 * One Browser Run session shared by the jobs a runner holds. Pages are opened
 * strictly one at a time (OLX sees a single, ordinary visitor) in a fresh
 * context each (no cookies carried between jobs). The session is closed as
 * soon as nobody waits for it, or when it reaches `sessionMaxMs`.
 */
export class CloudBrowserSession {
  private browser: BrowserLike | null = null;
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private holds = 0;
  private active = false;
  launches = 0;

  private readonly provider: BrowserProvider;
  private readonly hooks: SessionHooks;
  private readonly options: { sessionMaxMs: number; keepAliveMs: number; blockHeavyResources: boolean; restrictToOlxDomains: boolean; pageJavaScript: boolean };

  constructor(provider: BrowserProvider, hooks: SessionHooks, options: CloudBrowserSession["options"]) {
    this.provider = provider;
    this.hooks = hooks;
    this.options = options;
  }

  openSessionStartedAt(): number | null {
    return this.startedAt;
  }

  /**
   * Marks a claimed job that will scrape soon, so the session is kept open for
   * it instead of being closed and re-acquired (Free allows 1 new browser per
   * 20 s). The returned release is idempotent; `scrapeFor` releases on first use.
   */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
    };
  }

  /** Scrape function for one job (signature expected by the shared `runOlxJob` runner). */
  scrapeFor(release: () => void, options: InPageOptions): (requestUrl: string, signal: AbortSignal) => Promise<ScrapeResult> {
    return (requestUrl, signal) => {
      release();
      return this.scrape(requestUrl, signal, options);
    };
  }

  scrape = (requestUrl: string, signal: AbortSignal, options: InPageOptions = { idMode: "legacy" }): Promise<ScrapeResult> => {
    const url = assertAllowedOlxUrl(requestUrl).toString();
    this.waiting += 1;
    // `queue` never rejects (see below), so pages are opened strictly one after another.
    const run = this.queue.then(async () => {
      this.waiting -= 1;
      signal.throwIfAborted();
      return this.scrapeExclusive(url, signal, options);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  };

  /** Closes the session when no claimed job still needs it (e.g. a held job ended before scraping). */
  async closeIfIdle(): Promise<void> {
    if (this.browser && !this.active && this.waiting === 0 && this.holds === 0) await this.close("idle");
  }

  async close(reason: string): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    const startedAt = this.startedAt ?? this.hooks.now();
    const sessionId = this.sessionId;
    this.browser = null;
    this.startedAt = null;
    this.sessionId = null;
    await browser.close().catch(() => undefined);
    const localMs = Math.max(0, this.hooks.now() - startedAt);
    let serverMs: number | null = null;
    if (sessionId && this.provider.closedSessionDurationMs) {
      try {
        this.hooks.countSubrequest("browser_history");
        serverMs = await this.provider.closedSessionDurationMs(sessionId);
      } catch {
        serverMs = null;
      }
    }
    const chargedMs = Math.max(localMs, serverMs ?? 0);
    this.hooks.log("BROWSER_SESSION_CLOSED", { reason, localMs, serverMs, chargedMs });
    await this.hooks.onSessionClosed(chargedMs, sessionId);
  }

  private async scrapeExclusive(url: string, signal: AbortSignal, options: InPageOptions): Promise<ScrapeResult> {
    const startedAt = this.hooks.now();
    this.active = true;
    try {
      return await this.scrapeOnce(url, signal, startedAt, options);
    } finally {
      this.active = false;
      const age = this.startedAt === null ? 0 : this.hooks.now() - this.startedAt;
      const idle = this.waiting === 0 && this.holds === 0;
      if (this.browser && (idle || age >= this.options.sessionMaxMs || signal.aborted)) {
        await this.close(signal.aborted ? "job_aborted" : idle ? "idle" : "session_max_age");
      }
    }
  }

  private async scrapeOnce(url: string, signal: AbortSignal, startedAt: number, options: InPageOptions): Promise<ScrapeResult> {
    this.hooks.assertBudget(this.startedAt);
    const browser = await this.ensureBrowser(signal);
    const closeOnAbort = () => { void this.close("job_aborted"); };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    let context: ContextLike | null = null;
    try {
      context = await browser.newContext({ locale: "pl-PL", javaScriptEnabled: this.options.pageJavaScript });
      const page = await context.newPage();
      if (this.options.blockHeavyResources) await this.blockHeavyResources(context, page);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      signal.throwIfAborted();
      const status = response?.status() ?? null;
      const { header, second } = decodeInPageResult(await page.evaluate(inPageExpression(options)));
      signal.throwIfAborted();
      await context.close().catch(() => undefined);
      context = null;
      const extracted = header.page;
      // Same classification as the local worker: OLX refusing access is final, never retried or worked around.
      const refusal = status === 403 || status === 405 || status === 429 ? `OLX_HTTP_${status}` : extracted.challenge ? "OLX_HUMAN_VERIFICATION" : null;
      if (refusal) {
        await this.hooks.onOlxRefused(refusal);
        throw new ControlledOlxFailure(refusal, `OLX refused normal browser access (${refusal}).`);
      }
      if (!response?.ok()) throw new Error(`OLX_HTTP_${status ?? "UNKNOWN"}`);
      // A redirect away from olx.pl (login wall, consent host, …) is never followed further or parsed.
      if (!isOlxUrl(extracted.finalUrl)) throw new ControlledOlxFailure("OLX_CLOUD_UNEXPECTED_REDIRECT", "OLX przekierował poza olx.pl — strona nie została przetworzona.");
      await this.hooks.onOlxAccepted();
      if (header.error) {
        // Parser errors keep the Finder parser's own messages (same as the local worker). Any other in-page
        // failure ends the job explicitly: re-parsing ~1 MB here would exceed the Workers Free CPU limit
        // and an invocation killed for CPU would lose every job it holds.
        if (isParserError(header.error)) throw new Error(header.error);
        throw new ControlledOlxFailure("OLX_CLOUD_IN_PAGE_PARSER_FAILED", `Parser OLX w przeglądarce Cloudflare zawiódł (${header.error.slice(0, 200)}); zadanie zakończone bez parsowania w Workerze (limit CPU).`);
      }
      const listings = rawListings(second);
      const { rawItems, normalizedItems, warnings, verification } = header;
      this.hooks.log("OLX_PAGE_VERIFIED", {
        rawItems, normalizedItems, uniqueIds: verification?.uniqueIds ?? null, domCards: extracted.domCards,
        meta: extracted.meta, coverage: verification?.coverage ?? null, warnings, stateSource: extracted.stateSource, htmlLength: extracted.htmlLength,
        listingsBytes: second.length, javaScript: this.options.pageJavaScript, idMode: options.idMode, fixes: header.fixReport,
      });
      const durationMs = this.hooks.now() - startedAt;
      return {
        rawItems, normalizedItems, listings, warnings,
        diagnostics: { status, finalUrl: extracted.finalUrl, title: extracted.title, bodyLength: extracted.htmlLength, marker: extracted.marker, challenge: false, stateSource: extracted.stateSource, browserMs: durationMs },
        durationMs,
        verification,
        fixReport: header.fixReport,
      };
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      if (context) await context.close().catch(() => undefined);
    }
  }

  private async ensureBrowser(signal: AbortSignal): Promise<BrowserLike> {
    if (this.browser) return this.browser;
    let acquisitionsAllowed = true;
    if (this.provider.limits) {
      this.hooks.countSubrequest("browser_limits");
      const limits = await this.provider.limits();
      if (limits.allowedBrowserAcquisitions < 1) {
        const waitMs = Math.min(MAX_ACQUIRE_WAIT_MS, Math.max(1_000, limits.timeUntilNextAllowedBrowserAcquisition));
        this.hooks.log("BROWSER_ACQUIRE_WAIT", { waitMs });
        await this.hooks.sleep(waitMs, signal);
        acquisitionsAllowed = false;
      }
    }
    // Re-check: waiting must not let us start a session the budget no longer covers.
    this.hooks.assertBudget(null);
    const startedAt = this.hooks.now();
    let launched: { browser: BrowserLike; sessionId: string | null };
    try {
      this.hooks.countSubrequest("browser_acquire");
      this.hooks.countSubrequest("browser_websocket");
      launched = await this.provider.launch({ keepAliveMs: this.options.keepAliveMs, restrictToOlxDomains: this.options.restrictToOlxDomains });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b429\b|rate limit|too many/i.test(message)) {
        if (acquisitionsAllowed) {
          await this.hooks.onDailyLimitRejected();
          throw new ControlledOlxFailure("OLX_CLOUD_BROWSER_DAILY_LIMIT_429", "Cloudflare Browser Run odrzucił sesję (HTTP 429): dzienny limit planu wyczerpany.");
        }
        throw new ControlledOlxFailure("OLX_CLOUD_BROWSER_RATE_LIMITED", "Cloudflare Browser Run: limit nowych sesji (1 na 20 s) — zadanie nie zostało pobrane.");
      }
      throw new Error(`OLX_CLOUD_BROWSER_LAUNCH_FAILED: ${message.slice(0, 300)}`);
    }
    this.browser = launched.browser;
    this.sessionId = launched.sessionId;
    this.startedAt = startedAt;
    this.launches += 1;
    await this.hooks.onSessionOpened(startedAt, launched.sessionId);
    this.hooks.log("BROWSER_SESSION_OPENED", { launches: this.launches });
    return launched.browser;
  }

  private async blockHeavyResources(context: ContextLike, page: PageLike): Promise<void> {
    if (!context.newCDPSession) return;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setBlockedURLs", { urls: BLOCKED_URL_PATTERNS });
    } catch {
      // Optional optimisation only; the page is read the same way without it.
      this.hooks.log("BROWSER_RESOURCE_BLOCKING_UNAVAILABLE", {});
    }
  }
}

function isOlxUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "olx.pl" || url.hostname === "www.olx.pl");
  } catch {
    return false;
  }
}
