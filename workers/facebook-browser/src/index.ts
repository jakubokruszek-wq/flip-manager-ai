import { createFacebookApiClient } from "./api-client.ts";
import { fetchFacebookGroupWithBrowser } from "./browser.ts";
import { loadFacebookWorkerConfig, resolveFacebookProfileDir } from "./config.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { logFacebookWorker } from "./logger.ts";
import { openFacebookLogin } from "./session.ts";
import type { FacebookWorkerJob } from "../../../features/facebook-worker/types.ts";
import { parseFacebookMaxPostsArgument } from "./post-page.ts";

const loginMode = process.argv.includes("--login");
const timeDiagnosticMode = process.argv.includes("--time-diagnostic");
const mediaDiagnosticMode = process.argv.includes("--media-diagnostic");
const debugMaxPosts = parseFacebookMaxPostsArgument(process.argv);
if (loginMode) {
  await openFacebookLogin(resolveFacebookProfileDir());
} else {
  const config = loadFacebookWorkerConfig(); const api = createFacebookApiClient(config); const shutdown = new AbortController(); let activeJob: FacebookWorkerJob | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { logFacebookWorker("FACEBOOK_WORKER_SHUTDOWN", { signal, activeJobId: activeJob?.id ?? null }); shutdown.abort(); });
  logFacebookWorker("FACEBOOK_WORKER_START", { workerId: config.workerId, once: config.once, timeDiagnosticMode, mediaDiagnosticMode, debugMaxPosts });
  while (!shutdown.signal.aborted) {
    try {
      const { job } = await api.claim(shutdown.signal);
      if (job) {
        activeJob = job; logFacebookWorker("FACEBOOK_JOB_START", { jobId: job.id, runId: job.runId, attempt: job.attempts });
        const heartbeat = setInterval(() => void api.heartbeat(job, shutdown.signal).then(() => logFacebookWorker("FACEBOOK_JOB_HEARTBEAT", { jobId: job.id })).catch((error) => logFacebookWorker("FACEBOOK_JOB_HEARTBEAT_ERROR", { jobId: job.id, message: safeMessage(error) })), 30_000);
        try {
          const result = await fetchFacebookGroupWithBrowser(config.profileDir, job.groups[0], shutdown.signal, async (input, signal) => (await api.vision(job, input, signal)).vision, async () => { await api.heartbeat(job, shutdown.signal); }, timeDiagnosticMode, debugMaxPosts, mediaDiagnosticMode);
          await api.complete(job, result, shutdown.signal); logFacebookWorker("FACEBOOK_JOB_COMPLETE", { jobId: job.id, posts: result.posts.length, durationMs: result.durationMs });
        } catch (error) {
          const code = error instanceof ControlledFacebookFailure ? error.code : shutdown.signal.aborted ? "WORKER_SHUTDOWN" : "FACEBOOK_WORKER_ERROR";
          logFacebookWorker("FACEBOOK_JOB_ERROR", { jobId: job.id, code, message: safeMessage(error) });
          if (!shutdown.signal.aborted) await api.fail(job, code, safeMessage(error)).catch((failure) => logFacebookWorker("FACEBOOK_JOB_FAIL_REPORT_ERROR", { jobId: job.id, message: safeMessage(failure) }));
        } finally { clearInterval(heartbeat); activeJob = null; }
      } else if (config.once) break;
    } catch (error) { if (shutdown.signal.aborted) break; logFacebookWorker("FACEBOOK_WORKER_POLL_ERROR", { message: safeMessage(error) }); }
    if (config.once) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  logFacebookWorker("FACEBOOK_WORKER_STOP", { workerId: config.workerId });
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000); }
