// TEST-ONLY stand-in for the Flip Manager /api/olx-worker/* routes. It checks
// the real HMAC protocol (verifyWorkerAuth + single-use nonces) and models the
// queue rules of claim_olx_scan_job / heartbeat / complete / fail: oldest
// queued job first, a fresh lease token per claim, expired leases requeued
// until max_attempts, and every write rejected unless it carries the current
// lease token of the worker that holds the job. Never contacts Supabase.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { verifyWorkerAuth } from "../../../features/flip-finder/olx-worker-protocol.ts";

export type FakeJob = {
  id: string;
  requestUrl: string;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leasedUntil: number | null;
  workerId: string | null;
  createdAt: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
};

export type ApiEvent = { at: number; path: string; jobId: string | null; workerId: string | null; ok: boolean; detail?: unknown };

export async function startFakeQueueApi(options: { secret: string; leaseSeconds?: number }) {
  const leaseMs = (options.leaseSeconds ?? 120) * 1000;
  const jobs: FakeJob[] = [];
  const events: ApiEvent[] = [];
  const nonces = new Set<string>();
  let authFailures = 0;

  function requeueExpired(now: number): void {
    for (const job of jobs) {
      if (job.status !== "running" || job.leasedUntil === null || job.leasedUntil >= now) continue;
      if (job.attempts >= job.maxAttempts) Object.assign(job, { status: "failed", leaseToken: null, leasedUntil: null, errorCode: "LEASE_EXHAUSTED" });
      else Object.assign(job, { status: "queued", leaseToken: null, leasedUntil: null, workerId: null, errorCode: "LEASE_RECOVERED" });
    }
  }

  function owned(body: Record<string, unknown>): FakeJob | null {
    const job = jobs.find((candidate) => candidate.id === body.jobId);
    if (!job || job.status !== "running" || job.leaseToken !== body.leaseToken || job.workerId !== body.workerId) return null;
    if (job.leasedUntil === null || job.leasedUntil <= Date.now()) return null;
    return job;
  }

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const auth = await verifyWorkerAuth({
      secret: options.secret, method: request.method ?? "POST", pathname, body,
      headers: new Headers(request.headers as Record<string, string>),
      useNonce: async (nonce) => !nonces.has(nonce) && Boolean(nonces.add(nonce)),
    });
    if (!auth.ok) { authFailures += 1; return json(response, 401, { error: auth.code }); }
    const payload = JSON.parse(body) as Record<string, unknown>;
    const workerId = typeof payload.workerId === "string" ? payload.workerId : null;
    const now = Date.now();

    if (pathname === "/api/olx-worker/claim") {
      requeueExpired(now);
      const job = jobs.filter((candidate) => candidate.status === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!job) { events.push({ at: now, path: "claim", jobId: null, workerId, ok: true }); return json(response, 200, { job: null }); }
      Object.assign(job, { status: "running", attempts: job.attempts + 1, leaseToken: randomUUID(), leasedUntil: now + leaseMs, workerId, errorCode: null });
      events.push({ at: now, path: "claim", jobId: job.id, workerId, ok: true, detail: { attempts: job.attempts, leaseToken: job.leaseToken } });
      return json(response, 200, { job: {
        id: job.id, runId: `run-${job.id}`, sourceScanId: `scan-${job.id}`, filterId: "filter-test", contextType: "finder",
        requestUrl: job.requestUrl, leaseToken: job.leaseToken, leasedUntil: new Date(job.leasedUntil!).toISOString(), attempts: job.attempts,
      } });
    }

    const job = owned(payload);
    const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
    if (!job) { events.push({ at: now, path: pathname.split("/").at(-1)!, jobId, workerId, ok: false }); return json(response, 409, { error: "OLX_JOB_LEASE_LOST" }); }
    if (pathname === "/api/olx-worker/heartbeat") {
      job.leasedUntil = now + leaseMs;
      events.push({ at: now, path: "heartbeat", jobId, workerId, ok: true, detail: { leasedUntil: job.leasedUntil } });
      return json(response, 200, { ok: true, jobLeasedUntil: new Date(job.leasedUntil).toISOString(), radarLeaseUntil: null });
    }
    if (pathname === "/api/olx-worker/complete") {
      Object.assign(job, { status: "completed", leaseToken: null, leasedUntil: null, result: { fetched: payload.fetched, listings: Array.isArray(payload.listings) ? payload.listings.length : null, durationMs: payload.durationMs } });
      events.push({ at: now, path: "complete", jobId, workerId, ok: true, detail: job.result });
      return json(response, 200, { ok: true });
    }
    if (pathname === "/api/olx-worker/fail") {
      Object.assign(job, { status: "failed", leaseToken: null, leasedUntil: null, errorCode: String(payload.errorCode) });
      events.push({ at: now, path: "fail", jobId, workerId, ok: true, detail: { errorCode: payload.errorCode } });
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "NOT_FOUND" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("fake API did not bind");

  return {
    url: `http://localhost:${address.port}`,
    jobs,
    events,
    get authFailures() { return authFailures; },
    enqueue(count = 1, requestUrl = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/"): FakeJob[] {
      const created = Array.from({ length: count }, (_, index) => ({
        id: `job-${jobs.length + index + 1}`, requestUrl, status: "queued" as const, attempts: 0, maxAttempts: 3,
        leaseToken: null, leasedUntil: null, workerId: null, createdAt: Date.now() + index, result: null, errorCode: null,
      }));
      jobs.push(...created);
      return created;
    },
    /** Simulates the 120 s lease running out without waiting for it. */
    expireLeases(): void {
      for (const job of jobs) if (job.status === "running") job.leasedUntil = Date.now() - 1;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
