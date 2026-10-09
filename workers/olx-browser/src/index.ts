import { createApiClient, type WorkerJob } from "./api-client.ts";
import { fetchOlxWithBrowser } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { runOlxJob } from "./job-runner.ts";
import { createIdlePollBackoff } from "../../shared/idle-poll-backoff.ts";

const config = loadConfig();
const api = createApiClient(config);
const pollBackoff = createIdlePollBackoff(config.pollIntervalMs);
const shutdown = new AbortController();
let activeJob: WorkerJob | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  log("WORKER_SHUTDOWN", { signal, activeJobId: activeJob?.id ?? null });
  shutdown.abort();
});

async function runJob(job: WorkerJob): Promise<void> {
  activeJob = job;
  try {
    await runOlxJob({ job, api, scrape: fetchOlxWithBrowser, shutdownSignal: shutdown.signal, log });
  } finally {
    activeJob = null;
  }
}

async function main(): Promise<void> {
  log("WORKER_START", { workerId: config.workerId, once: config.once });
  while (!shutdown.signal.aborted) {
    try {
      const { job } = await api.claim(shutdown.signal);
      if (job) {
        pollBackoff.recordClaimWithJob();
        await runJob(job);
      } else {
        pollBackoff.recordEmptyClaim();
        if (config.once) break;
      }
    } catch (error) {
      if (shutdown.signal.aborted) break;
      pollBackoff.recordRequestError();
      log("WORKER_POLL_ERROR", { message: error instanceof Error ? error.message : String(error) });
    }
    if (config.once) break;
    await new Promise((resolve) => setTimeout(resolve, pollBackoff.currentDelayMs()));
  }
  log("WORKER_STOP", { workerId: config.workerId });
}

void main().catch((error) => {
  log("WORKER_FATAL", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
