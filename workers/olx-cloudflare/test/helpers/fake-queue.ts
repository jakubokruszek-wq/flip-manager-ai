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
};

export type FakeQueue = {
  url: string;
  jobs: FakeJob[];
  requests: Array<{ path: string; status: number; body: string }>;
  authFailures: string[];
  enqueue(input: { id?: string; idempotencyKey: string; requestUrl?: string; contextType?: "finder" | "price_radar"; createdAt?: number; filterId?: string }): FakeJob | null;
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
  const state = { selectiveAvailable: true };

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
        // Mirrors claim_olx_scan_job_selective (migration 20261013150000): only a queued
        // Finder job matching the selector; no lease recovery, no other row touched.
        if (!state.selectiveAvailable) { reply(503, { error: "OLX_SELECTIVE_CLAIM_UNAVAILABLE" }); return; }
        const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
        const filterId = typeof payload.filterId === "string" ? payload.filterId : null;
        if ((jobId === null) === (filterId === null)) { reply(400, { error: "INVALID_SELECTOR" }); return; }
        const candidate = jobs
          .filter((item) => item.status === "queued" && item.contextType === "finder" && (jobId ? item.id === jobId : item.filterId === filterId))
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!candidate) { reply(200, { job: null }); return; }
        const now = Date.now();
        Object.assign(candidate, { status: "running", attempts: candidate.attempts + 1, leaseToken: randomUUID(), leasedUntil: now + LEASE_MS, heartbeatAt: now, workerId: String(payload.workerId) });
        reply(200, { job: describe(candidate, now) });
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
