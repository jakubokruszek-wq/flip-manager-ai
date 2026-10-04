import { runFinderScanScheduler } from "@/features/flip-finder/server/finder-scheduler";
import { authorizeFinderSchedulerRequest } from "@/features/auth/github-actions-oidc";
import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Starts bounded Finder runs for filters whose own cadence has elapsed. The
 * hourly continuation endpoint remains a separate mechanism for the same
 * run's pending source rows.
 *
 * Responds immediately after authorization, before the scheduler cycle
 * (claim + reserve + the sequential per-source fetch loop, which can run for
 * tens of seconds) ever starts. Some free external trigger services (e.g.
 * cron-job.org) close the connection ~30s in, well inside that window, which
 * would otherwise turn a slow-but-legitimate run into a client-perceived
 * failure on every single invocation. The real work is deferred via
 * runAfterResponse (next/server's after(), backed by the platform's
 * waitUntil -- the same mechanism this codebase already uses for the
 * operator-facing "Scan now" button), so a fast ACK here never means the
 * scan didn't happen; its outcome is only observable via
 * FINDER_SCHEDULER_RUN_COMPLETE/_FAILED in the function logs, not the HTTP
 * response body.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!await authorizeFinderSchedulerRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  runAfterResponse(async () => {
    try {
      const result = await runFinderScanScheduler();
      console.info("FINDER_SCHEDULER_RUN_COMPLETE", result);
    } catch (error) {
      console.error("FINDER_SCHEDULER_RUN_FAILED", error instanceof Error ? error.message : error);
    }
  });
  return Response.json({ status: "accepted" }, { status: 202 });
}
