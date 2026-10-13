import { randomUUID } from "node:crypto";

import {
  createWorkerAuthHeaders,
  OLX_WORKER_NONCE_HEADER,
  OLX_WORKER_SIGNATURE_HEADER,
  OLX_WORKER_TIMESTAMP_HEADER,
} from "../../../features/flip-finder/olx-worker-protocol.ts";
import { canScrape, currentLedger, type BudgetLimits, type Ledger } from "./budget.ts";
import type { BrowserProvider } from "./browser-session.ts";
import { checkCloudConfig, parseCloudConfig } from "./config.ts";
import type { LedgerStore } from "./runner.ts";

/**
 * Stage-1 verification that never claims, scrapes or changes a job.
 *
 * Queue API: a correctly signed heartbeat for a random, non-existent job id.
 * The app authenticates the HMAC first (401 on a wrong secret or clock), then
 * looks for a running job with that id and lease token — none exists, so it
 * answers 409 OLX_JOB_LEASE_LOST without updating any row. The only write is
 * the single-use HMAC nonce, which the app deletes after 5 minutes.
 *
 * Browser Run (opt-in, ?browser=1): opens and closes one blank browser (no
 * page is visited) and charges its time to the daily ledger.
 */
export async function runSelfTest(environment: Record<string, unknown>, options: { withBrowser: boolean; selectiveProbe?: boolean; browser: BrowserProvider; ledger: LedgerStore }): Promise<Record<string, unknown>> {
  const config = checkCloudConfig(environment);
  const parsed = parseCloudConfig(environment);
  const result: Record<string, unknown> = { config, queueApi: null, selectiveClaim: null, browserRun: null };
  if (!parsed.ok) {
    result.queueApi = { ok: false, code: "OLX_CLOUD_CONFIG_INVALID", message: parsed.message };
    return result;
  }
  const { apiUrl, secret, workerId } = parsed.config;
  const body = JSON.stringify({ jobId: randomUUID(), leaseToken: randomUUID(), workerId: `${workerId}-selftest`.slice(0, 100), radarLeaseToken: null });
  const url = new URL("/api/olx-worker/heartbeat", apiUrl);
  const auth = createWorkerAuthHeaders({ secret, method: "POST", pathname: url.pathname, body });
  try {
    const response = await fetch(url, {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp, [OLX_WORKER_NONCE_HEADER]: auth.nonce, [OLX_WORKER_SIGNATURE_HEADER]: auth.signature },
    });
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const error = typeof payload?.error === "string" ? payload.error : null;
    result.queueApi = response.status === 409 && error === "OLX_JOB_LEASE_LOST"
      ? { ok: true, status: 409, meaning: "HMAC przyjęty, API i baza odpowiadają; żadne zadanie nie zostało pobrane ani zmienione." }
      : { ok: false, status: response.status, error, meaning: response.status === 401 ? "Aplikacja odrzuciła podpis HMAC (inny OLX_WORKER_SECRET niż w Vercel albo zegar)." : response.status === 503 ? "Aplikacja nie ma ustawionego OLX_WORKER_SECRET." : "Nieoczekiwana odpowiedź API." };
  } catch (failure) {
    result.queueApi = { ok: false, error: failure instanceof Error ? failure.message : String(failure), meaning: "Brak połączenia z OLX_WORKER_API_URL." };
  }

  if (options.selectiveProbe) result.selectiveClaim = await probeSelectiveClaim(apiUrl, secret, workerId);

  if (options.withBrowser) {
    const limits: BudgetLimits = { dailyBrowserLimitMs: parsed.config.dailyBrowserLimitMs, safeBrowserBudgetMs: parsed.config.safeBrowserBudgetMs, scrapeReserveMs: 15_000, sessionMaxMs: parsed.config.sessionMaxMs, keepAliveMs: parsed.config.keepAliveMs, maxJobsPerDay: 0 };
    let ledger: Ledger = currentLedger(await options.ledger.load(), Date.now(), limits);
    if (!canScrape(ledger, Date.now(), null, limits)) {
      result.browserRun = { ok: false, code: "OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED", browserSecondsUsedToday: Math.round(ledger.browserMs / 1000) };
      return result;
    }
    const started = Date.now();
    try {
      const { browser } = await options.browser.launch({ keepAliveMs: 10_000, restrictToOlxDomains: false });
      try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        const value = await page.evaluate("1 + 1");
        result.browserRun = { ok: value === 2 };
      } finally {
        await browser.close().catch(() => undefined);
      }
    } catch (failure) {
      result.browserRun = { ok: false, error: failure instanceof Error ? failure.message.slice(0, 300) : String(failure) };
    }
    const elapsed = Date.now() - started;
    ledger = currentLedger(await options.ledger.load(), Date.now(), limits);
    await options.ledger.save({ ...ledger, browserMs: ledger.browserMs + elapsed, sessions: ledger.sessions + 1 });
    result.browserRun = { ...(result.browserRun as object), browserMs: elapsed };
  }
  return result;
}

/**
 * Is /api/olx-worker/claim-selective deployed and is its SQL function present?
 * Asks it to claim a random, non-existent job id: the function selects no row
 * (nothing is locked or changed) and the route answers `{ job: null }`.
 * 503 = migration missing, 404 = route not deployed. Never names a real job.
 */
async function probeSelectiveClaim(apiUrl: URL, secret: string, workerId: string): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ workerId: `${workerId}-probe`.slice(0, 100), jobId: randomUUID() });
  const url = new URL("/api/olx-worker/claim-selective", apiUrl);
  const auth = createWorkerAuthHeaders({ secret, method: "POST", pathname: url.pathname, body });
  try {
    const response = await fetch(url, {
      method: "POST", body, cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp, [OLX_WORKER_NONCE_HEADER]: auth.nonce, [OLX_WORKER_SIGNATURE_HEADER]: auth.signature },
    });
    const payload = await response.json().catch(() => null) as { job?: unknown; error?: unknown } | null;
    if (response.ok && payload && "job" in payload && payload.job === null) {
      return { ok: true, status: response.status, meaning: "claim-selective wdrożony, funkcja SQL obecna; losowe ID nie wskazało żadnego zadania." };
    }
    const error = typeof payload?.error === "string" ? payload.error : null;
    return {
      ok: false, status: response.status, error,
      meaning: response.status === 503 ? "Brak migracji claim_olx_scan_job_selective w Supabase."
        : response.status === 404 ? "Endpoint /api/olx-worker/claim-selective nie jest wdrożony w aplikacji."
        : response.status === 401 ? "Aplikacja odrzuciła podpis HMAC." : "Nieoczekiwana odpowiedź claim-selective.",
    };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure), meaning: "Brak połączenia z OLX_WORKER_API_URL." };
  }
}
