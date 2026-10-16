import { createApiClient } from "./api-client.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logger.ts";
import { createWorkerMonitor } from "./monitor.ts";
import { createStallWatchdog } from "./watchdog.ts";
import { runWorker, type WorkerDependencies } from "./worker.ts";

/**
 * Production process wiring shared by index.ts and the container fixture test:
 * configuration from the environment, signal handling, crash/stall exits and
 * periodic WORKER_STATUS monitoring lines.
 */
export function startWorkerProcess(options: Pick<WorkerDependencies, "scrape" | "jobTiming">): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    // Messages name the variable only, never its value.
    log("WORKER_CONFIG_ERROR", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    return Promise.resolve();
  }
  const monitor = createWorkerMonitor({ workerId: config.workerId });
  const shutdown = new AbortController();

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    log("WORKER_SHUTDOWN", { signal, activeJobId: monitor.snapshot().activeJob?.jobId ?? null });
    shutdown.abort();
  });

  // Any escaped error leaves the loop in an unknown state: exit non-zero so the
  // supervisor (Railway restart policy / Windows supervisor) starts a clean
  // process. The job lease then expires and the queue hands the job out again.
  for (const event of ["uncaughtException", "unhandledRejection"] as const) process.on(event, (error) => {
    log("WORKER_FATAL", { source: event, message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });

  const watchdog = createStallWatchdog({
    onStall: (details) => {
      log("WORKER_WATCHDOG_STALL", { ...details, status: monitor.snapshot() });
      process.exit(1);
    },
  });

  const statusTimer = setInterval(() => log("WORKER_STATUS", monitor.snapshot()), config.statusLogIntervalMs);
  statusTimer.unref();

  return runWorker({ config, api: createApiClient(config), scrape: options.scrape, jobTiming: options.jobTiming, log, shutdownSignal: shutdown.signal, monitor, watchdog })
    .catch((error) => {
      log("WORKER_FATAL", { message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(() => {
      watchdog.stop();
      clearInterval(statusTimer);
    });
}
