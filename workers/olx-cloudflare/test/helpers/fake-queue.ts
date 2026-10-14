/**
 * Fictitious `olx_scan_jobs` queue behind the real `/api/olx-worker/*` HTTP
 * contract. Requests are verified with the production HMAC verifier
 * (timestamp window, signature over method/path/body hash, single-use nonce).
 * Queue transitions use Finder's own pure state model (olx-job-state.ts), and
 * Finder's 90-second "never claimed" watchdog is reproduced. Completion
 * payloads are checked with the same constraints `parseOlxCompletionPayload`
 * enforces in production.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { verifyWorkerAuth } from "../../../../features/flip-finder/olx-worker-protocol.ts";
import { claimNext, enqueueUnique, heartbeat, recoverExpiredLeases, type OlxJobState } from "../../../../features/flip-finder/olx-job-state.ts";

export const FAKE_SECRET = "fake-queue-integration-secret-with-32+-chars";

export type FakeJob = OlxJobState & {
  requestUrl: string;
  createdAt: number;
  contextType: "finder" | "price_radar";
  radarLeaseToken: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  completion: Record<string, unknown> | null;
  workerId: string | null;
  filterId: string;
  /** "scheduler" = queued by the Finder OLX schedule (olx_scan_jobs.requested_by). */
  requestedBy: "scheduler" | null;
  startedAt: number | null;
};

export type FakeQueue = {
  url: string;
  jobs: FakeJob[];
  requests: Array<{ path: string; status: number; body: string }>;
  authFailures: string[];
  enqueue(input: { id?: string; idempotencyKey: string; requestUrl?: string; contextType?: "finder" | "price_radar"; createdAt?: number; filterId?: string; requestedBy?: "scheduler" | null }): FakeJob | null;
  /** olx_automation_control.scheduled_claim_enabled; false = STOP. */
  setAutomationEnabled(value: boolean): void;
  /** false = the scheduled-claim migration is not applied (endpoint answers 503). */
  setScheduledAvailable(value: boolean): void;
  /** olx_automation_control.max_claims_24h (0..2, default 1). */
  setMaxClaims(value: number): void;
  /** Usage reports received with claim-scheduled (olx_cloud_budget). */
  usageReports: Array<Record<string, unknown> | null>;
  /** Finder's watchdog: a job never claimed within 90 s is failed with OLX_WORKER_CLAIM_TIMEOUT. */
  runUnclaimedWatchdog(now?: number): number;
  /** Simulates the lease being revoked server-side (e.g. Radar run cancelled). */
  revokeLease(jobId: string): void;
  failNextRequests(path: string, count: number): void;
  /** false = the selective-claim migration is not applied (endpoint answers 503). */
  setSelectiveAvailable(value: boolean): void;
  close(): Promise<void>;
};

const LEASE_MS = 120_000;
const DEFAULT_URL = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/";

export async function startFakeQueue(options: { secret?: string } = {}): Promise<FakeQueue> {
  const secret = options.secret ?? FAKE_SECRET;
  const jobs: FakeJob[] = [];
  const nonces = new Set<string>();
  const requests: FakeQueue["requests"] = [];
  const authFailures: string[] = [];
  const injectedFailures = new Map<string, number>();
  const state = { selectiveAvailable: true, scheduledAvailable: true, automationEnabled: true, maxClaims: 1 };
  const usageReports: Array<Record<string, unknown> | null> = [];

  const server: Server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const reply = (status: number, payload: unknown) => {
      requests.push({ path, status, body });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const auth = await verifyWorkerAuth({
      secret, method: request.method ?? "", pathname: path, body, headers: new Headers(request.headers as Record<string, string>),
      useNonce: async (nonce) => (nonces.has(nonce) ? false : (nonces.add(nonce), true)),
    });
    if (!auth.ok) { authFailures.push(auth.code); reply(401, { error: auth.code }); return; }
    const pending = injectedFailures.get(path) ?? 0;
    if (pending > 0) { injectedFailures.set(path, pending - 1); reply(503, { error: "FAKE_UPSTREAM_UNAVAILABLE" }); return; }
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      if (path === "/api/olx-worker/claim") { reply(200, { job: claim(String(payload.workerId)) }); return; }
      if (path === "/api/olx-worker/claim-selective") {
        // Mirrors claim_olx_scan_job_selective (migration 20261013180000) and its route:
        // body exactly { workerId, jobId }; only that queued Finder job, no lease recovery,
        // no other row touched.
        if (!state.selectiveAvailable) { reply(503, { error: "OLX_SELECTIVE_CLAIM_UNAVAILABLE" }); return; }
        if (Object.keys(payload).some((key) => key !== "workerId" && key !== "jobId")) { reply(400, { error: "INVALID_SELECTOR" }); return; }
        if (typeof payload.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.jobId)) { reply(400, { error: "INVALID_JOB_ID" }); return; }
        const now = Date.now();
        const candidate = jobs.find((item) => item.id === payload.jobId && item.status === "queued" && item.contextType === "finder" && item.attempts < item.maxAttempts);
        if (!candidate) { reply(200, { job: null }); return; }
        Object.assign(candidate, { status: "running", attempts: candidate.attempts + 1, leaseToken: randomUUID(), leasedUntil: now + LEASE_MS, heartbeatAt: now, workerId: String(payload.workerId) });
        reply(200, { job: describe(candidate, now) });
        return;
      }
      if (path === "/api/olx-worker/claim-scheduled") {
        // Mirrors claim_scheduled_finder_olx_job (migration 20261015120000) and its route:
        // body exactly { workerId }; STOP switch; nothing while any OLX job holds a live
        // lease; 1 scheduled claim per 24 h; only queued automatic Finder jobs, attempts 0,
        // younger than 6 h; no other row touched.
        if (!state.scheduledAvailable) { reply(503, { error: "OLX_SCHEDULED_CLAIM_UNAVAILABLE" }); return; }
        if (Object.keys(payload).some((key) => key !== "workerId" && key !== "usage")) { reply(400, { error: "INVALID_SELECTOR" }); return; }
        const now = Date.now();
        if (!state.automationEnabled) { reply(200, { job: null, reason: "AUTOMATION_DISABLED" }); return; }
        // Migration 20261016120000: the usage report is required and gates the claim.
        const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : null;
        usageReports.push(usage);
        const numbers = usage ? ["accountBrowserMs", "workerBrowserMs", "safeBudgetMs", "jobEstimateMs"].map((key) => usage[key]) : [];
        if (!usage || numbers.some((value) => typeof value !== "number" || value < 0) || Number(usage.jobEstimateMs) <= 0) { reply(200, { job: null, reason: "BROWSER_USAGE_UNKNOWN" }); return; }
        if (Math.max(Number(usage.accountBrowserMs), Number(usage.workerBrowserMs)) + Number(usage.jobEstimateMs) > Math.min(Number(usage.safeBudgetMs), 300_000)) { reply(200, { job: null, reason: "BROWSER_BUDGET_INSUFFICIENT" }); return; }
        if (jobs.some((item) => item.status === "running" && (item.leasedUntil ?? 0) > now)) { reply(200, { job: null, reason: "OLX_JOB_RUNNING" }); return; }
        if (jobs.filter((item) => item.requestedBy === "scheduler" && item.startedAt !== null && item.startedAt > now - 86_400_000).length >= state.maxClaims) { reply(200, { job: null, reason: "DAILY_CLAIM_USED" }); return; }
        const candidate = jobs.filter((item) => item.status === "queued" && item.contextType === "finder" && item.requestedBy === "scheduler" && item.attempts === 0 && item.createdAt > now - 6 * 3_600_000)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!candidate) { reply(200, { job: null, reason: "NO_DUE_JOB" }); return; }
        Object.assign(candidate, { status: "running", attempts: candidate.attempts + 1, leaseToken: randomUUID(), leasedUntil: now + LEASE_MS, heartbeatAt: now, workerId: String(payload.workerId), startedAt: now });
        reply(200, { job: describe(candidate, now), reason: null });
        return;
      }
      const job = jobs.find((item) => item.id === payload.jobId);
      const owns = job && job.status === "running" && job.leaseToken === payload.leaseToken && job.workerId === payload.workerId
        && (job.contextType !== "price_radar" || payload.radarLeaseToken === job.radarLeaseToken);
      if (path === "/api/olx-worker/heartbeat") {
        // Production (heartbeatOlxJob → route): 409 OLX_JOB_LEASE_LOST, no row changed.
        if (!job || !owns || !heartbeat(job, String(payload.leaseToken), Date.now())) { reply(409, { error: "OLX_JOB_LEASE_LOST" }); return; }
        const until = new Date(job.leasedUntil ?? 0).toISOString();
        reply(200, { ok: true, jobLeasedUntil: until, radarLeaseUntil: job.contextType === "price_radar" ? until : null });
        return;
      }
      if (path === "/api/olx-worker/complete") {
        if (!job || !owns) { reply(409, { error: "OLX_JOB_LEASE_NOT_ACTIVE" }); return; }
        validateCompletion(payload);
        Object.assign(job, { status: "completed", leaseToken: null, leasedUntil: null, completion: payload });
        reply(200, { ok: true, result: { source: "olx", status: "completed" } });
        return;
      }
      if (path === "/api/olx-worker/fail") {
        if (!job || !owns) { reply(409, { error: "OLX_JOB_LEASE_NOT_ACTIVE" }); return; }
        if (typeof payload.errorCode !== "string" || !payload.errorCode || typeof payload.errorMessage !== "string" || !payload.errorMessage) throw new Error("INVALID_PAYLOAD");
        Object.assign(job, { status: "failed", leaseToken: null, leasedUntil: null, errorCode: payload.errorCode.slice(0, 100), errorMessage: payload.errorMessage.slice(0, 1000) });
        reply(200, { ok: true });
        return;
      }
      reply(404, { error: "NOT_FOUND" });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : "BAD_REQUEST" });
    }
  });

  function claim(workerId: string) {
    if (workerId.trim().length < 3) throw new Error("worker_id is required");
    const now = Date.now();
    recoverExpiredLeases(jobs, now);
    const job = claimNext(jobs, now, randomUUID()) as FakeJob | null;
    if (!job) return null;
    job.workerId = workerId;
    if (job.contextType === "price_radar") job.radarLeaseToken = randomUUID();
    return describe(job, now);
  }

  function describe(job: FakeJob, now: number) {
    return {
      id: job.id, runId: `run-${job.id}`, sourceScanId: job.contextType === "finder" ? `scan-${job.id}` : null, filterId: job.contextType === "finder" ? job.filterId : null,
      contextType: job.contextType, radarOwnerId: job.contextType === "price_radar" ? "owner-1" : null,
      radarRunLeaseToken: job.radarLeaseToken, radarLeaseUntil: job.contextType === "price_radar" ? new Date(now + LEASE_MS).toISOString() : null,
      requestUrl: job.requestUrl, leaseToken: job.leaseToken, leasedUntil: new Date(job.leasedUntil ?? now).toISOString(), attempts: job.attempts,
    };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let enqueued: OlxJobState[] = jobs;

  return {
    url: `http://127.0.0.1:${port}`,
    jobs,
    requests,
    authFailures,
    enqueue(input) {
      const job: FakeJob = {
        id: input.id ?? randomUUID(), idempotencyKey: input.idempotencyKey, status: "queued", attempts: 0, maxAttempts: 3, leaseToken: null, leasedUntil: null, heartbeatAt: null,
        requestUrl: input.requestUrl ?? DEFAULT_URL, createdAt: input.createdAt ?? Date.now(), contextType: input.contextType ?? "finder", radarLeaseToken: null,
        errorCode: null, errorMessage: null, completion: null, workerId: null, filterId: input.filterId ?? "11111111-1111-4111-8111-111111111111",
        requestedBy: input.requestedBy ?? null, startedAt: null,
      };
      const next = enqueueUnique(enqueued, job);
      if (next.length === enqueued.length) return null;
      jobs.push(job);
      enqueued = jobs;
      return job;
    },
    runUnclaimedWatchdog(now = Date.now()) {
      let expired = 0;
      for (const job of jobs) {
        if (job.status === "queued" && job.attempts === 0 && job.createdAt < now - 90_000) {
          Object.assign(job, { status: "failed", errorCode: "OLX_WORKER_CLAIM_TIMEOUT", errorMessage: "OLX worker did not claim the queued job within 90 seconds" });
          expired += 1;
        }
      }
      return expired;
    },
    revokeLease(jobId) {
      const job = jobs.find((item) => item.id === jobId);
      if (job) job.leaseToken = randomUUID();
    },
    failNextRequests(path, count) { injectedFailures.set(path, count); },
    setSelectiveAvailable(value) { state.selectiveAvailable = value; },
    setAutomationEnabled(value) { state.automationEnabled = value; },
    setScheduledAvailable(value) { state.scheduledAvailable = value; },
    setMaxClaims(value) { state.maxClaims = value; },
    usageReports,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function validateCompletion(payload: Record<string, unknown>) {
  const listings = payload.listings;
  if (!Array.isArray(listings) || listings.length > 200) throw new Error("INVALID_LISTINGS");
  for (const key of ["fetched", "durationMs"]) {
    const value = payload[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER");
  }
  if (!Array.isArray(payload.warnings) || payload.warnings.some((item) => typeof item !== "string")) throw new Error("INVALID_STRING_ARRAY");
  for (const item of listings as Record<string, unknown>[]) {
    if (item.source !== "olx") throw new Error("INVALID_LISTING_SOURCE");
    for (const key of ["externalListingId", "originalUrl", "normalizedUrl", "contentHash"]) if (typeof item[key] !== "string" || !String(item[key]).trim()) throw new Error(`INVALID_${key.toUpperCase()}`);
    for (const key of ["originalUrl", "normalizedUrl"]) if (!/^https:\/\/(www\.)?olx\.pl\//.test(String(item[key]))) throw new Error("OLX_URL_NOT_ALLOWED");
    if (!item.rawPayload || typeof item.rawPayload !== "object") throw new Error("INVALID_PAYLOAD");
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
