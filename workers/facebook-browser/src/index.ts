import { createFacebookApiClient } from "./api-client.ts";
import { fetchFacebookGroupWithBrowser } from "./browser.ts";
import { loadFacebookWorkerConfig, resolveFacebookProfileDir } from "./config.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { logFacebookWorker } from "./logger.ts";
import { openFacebookLogin } from "./session.ts";
import type { FacebookWorkerJob } from "../../../features/facebook-worker/types.ts";
import { runFacebookJobCompletion, waitForFacebookTargetJob } from "./job-runner.ts";
import { parseFacebookMaxPostsArgument, parseFacebookPostIdArgument } from "./post-page.ts";
import { parseFacebookImageRevalidationArguments, runFacebookImageRevalidation } from "./image-revalidation.ts";
import { runWithFacebookGroupDeadline } from "./group-deadline.ts";

const loginMode = process.argv.includes("--login");
const timeDiagnosticMode = process.argv.includes("--time-diagnostic");
const mediaDiagnosticMode = process.argv.includes("--media-diagnostic");
const imageRevalidation = parseFacebookImageRevalidationArguments(process.argv);
const debugMaxPosts = parseFacebookMaxPostsArgument(process.argv);
const debugPostId = parseFacebookPostIdArgument(process.argv);
if (debugPostId && (timeDiagnosticMode || mediaDiagnosticMode)) throw new Error("--facebook-post-id cannot be combined with diagnostic modes.");
if (imageRevalidation.enabled && (loginMode || debugPostId || timeDiagnosticMode || mediaDiagnosticMode)) throw new Error("--revalidate-images cannot be combined with login, targeted or diagnostic modes.");
if (loginMode) {
  await openFacebookLogin(resolveFacebookProfileDir());
} else {
  const config = loadFacebookWorkerConfig(); const api = createFacebookApiClient(config); const shutdown = new AbortController(); let activeJob: FacebookWorkerJob | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { logFacebookWorker("FACEBOOK_WORKER_SHUTDOWN", { signal, activeJobId: activeJob?.id ?? null }); shutdown.abort(); });
  logFacebookWorker("FACEBOOK_WORKER_START", { workerId: config.workerId, once: config.once, timeDiagnosticMode, mediaDiagnosticMode, debugMaxPosts, debugPostId });
  if (imageRevalidation.enabled) {
    logFacebookWorker("FACEBOOK_IMAGE_REVALIDATION_START", { dryRun: imageRevalidation.dryRun, limit: imageRevalidation.limit, listingId: imageRevalidation.listingId, postId: imageRevalidation.postId });
    await runFacebookImageRevalidation(config, api, imageRevalidation, shutdown.signal);
    logFacebookWorker("FACEBOOK_WORKER_STOP", { workerId: config.workerId, mode: "IMAGE_REVALIDATION" });
  } else while (!shutdown.signal.aborted) {
    try {
      const job = debugPostId
        ? await waitForFacebookTargetJob({
          signal: shutdown.signal,
          pollIntervalMs: config.pollIntervalMs,
          claim: (signal) => api.claim(signal),
          onEmpty: () => logFacebookWorker("FACEBOOK_DEBUG_TARGET_WAITING_FOR_JOB", { workerId: config.workerId }),
        })
        : (await api.claim(shutdown.signal)).job;
      if (job) {
        activeJob = job; logFacebookWorker("FACEBOOK_JOB_START", { jobId: job.id, runId: job.runId, attempt: job.attempts });
        const heartbeat = setInterval(() => void api.heartbeat(job, shutdown.signal).then(() => logFacebookWorker("FACEBOOK_JOB_HEARTBEAT", { jobId: job.id })).catch((error) => logFacebookWorker("FACEBOOK_JOB_HEARTBEAT_ERROR", { jobId: job.id, message: safeMessage(error) })), 30_000);
        try {
          const result = await runFacebookJobCompletion(
            () => runWithFacebookGroupDeadline(() => fetchFacebookGroupWithBrowser(config.profileDir, job.group, shutdown.signal, async (input, signal) => (await api.vision(job, input, signal)).vision, async () => { await api.heartbeat(job, shutdown.signal); }, timeDiagnosticMode, debugMaxPosts, mediaDiagnosticMode, debugPostId, (postIds, signal) => api.postCache(job, postIds, signal)), shutdown.signal),
            (completedResult) => api.complete(job, completedResult, shutdown.signal),
          );
          logFacebookWorker("FACEBOOK_JOB_COMPLETE", { jobId: job.id, posts: result.posts.length, durationMs: result.durationMs });
        } catch (error) {
          const code = error instanceof ControlledFacebookFailure ? error.code : shutdown.signal.aborted ? "WORKER_SHUTDOWN" : "FACEBOOK_WORKER_ERROR";
          logFacebookWorker("FACEBOOK_JOB_ERROR", { jobId: job.id, code, message: safeMessage(error) });
          if (!shutdown.signal.aborted) await api.fail(job, code, safeMessage(error)).catch((failure) => logFacebookWorker("FACEBOOK_JOB_FAIL_REPORT_ERROR", { jobId: job.id, message: safeMessage(failure) }));
        } finally { clearInterval(heartbeat); activeJob = null; }
        if (debugPostId) break;
      } else if (config.once) break;
    } catch (error) { if (shutdown.signal.aborted) break; logFacebookWorker("FACEBOOK_WORKER_POLL_ERROR", { message: safeMessage(error) }); }
    if (config.once) break;
    if (!debugPostId) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  if (!imageRevalidation.enabled) logFacebookWorker("FACEBOOK_WORKER_STOP", { workerId: config.workerId });
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000); }
