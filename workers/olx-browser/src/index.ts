import { createApiClient, type WorkerJob } from "./api-client.ts";
import { fetchOlxWithBrowser } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { ControlledOlxFailure, withTransientRetry } from "./retry.ts";

const config = loadConfig();
const api = createApiClient(config);
const shutdown = new AbortController();
let activeJob: WorkerJob | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  log("WORKER_SHUTDOWN", { signal, activeJobId: activeJob?.id ?? null });
  shutdown.abort();
});

async function runJob(job: WorkerJob): Promise<void> {
  activeJob = job;
  const heartbeat = setInterval(() => {
    void api.heartbeat(job, shutdown.signal).then(() => log("JOB_HEARTBEAT", { jobId: job.id })).catch((error) => log("JOB_HEARTBEAT_ERROR", { jobId: job.id, message: error instanceof Error ? error.message : String(error) }));
  }, 30_000);
  try {
    log("JOB_START", { jobId: job.id, runId: job.runId, attempt: job.attempts });
    const result = await withTransientRetry((attempt) => {
      log("OLX_BROWSER_START", { jobId: job.id, attempt });
      return fetchOlxWithBrowser(job.requestUrl, shutdown.signal);
    });
    log("OLX_BROWSER_DONE", { jobId: job.id, status: result.diagnostics.status, finalUrl: result.diagnostics.finalUrl, title: result.diagnostics.title, bodyLength: result.diagnostics.bodyLength, marker: result.diagnostics.marker, rawItems: result.rawItems, normalizedItems: result.normalizedItems, durationMs: result.durationMs });
    await api.complete(job, { fetched: result.rawItems, listings: result.listings, warnings: result.warnings, durationMs: result.durationMs }, shutdown.signal);
    log("JOB_COMPLETE", { jobId: job.id, rawItems: result.rawItems, normalizedItems: result.normalizedItems });
  } catch (error) {
    const code = error instanceof ControlledOlxFailure ? error.code : shutdown.signal.aborted ? "WORKER_SHUTDOWN" : "OLX_WORKER_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    log("JOB_ERROR", { jobId: job.id, code, message });
    if (!shutdown.signal.aborted) await api.fail(job, code, message).catch((failure) => log("JOB_FAIL_REPORT_ERROR", { jobId: job.id, message: failure instanceof Error ? failure.message : String(failure) }));
  } finally {
    clearInterval(heartbeat);
    activeJob = null;
  }
}

async function main(): Promise<void> {
  log("WORKER_START", { workerId: config.workerId, once: config.once });
  while (!shutdown.signal.aborted) {
    try {
      const { job } = await api.claim(shutdown.signal);
      if (job) await runJob(job);
      else if (config.once) break;
    } catch (error) {
      if (shutdown.signal.aborted) break;
      log("WORKER_POLL_ERROR", { message: error instanceof Error ? error.message : String(error) });
    }
    if (config.once) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  log("WORKER_STOP", { workerId: config.workerId });
}

void main().catch((error) => {
  log("WORKER_FATAL", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
