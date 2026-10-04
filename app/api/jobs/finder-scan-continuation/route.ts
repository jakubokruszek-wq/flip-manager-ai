import { runFinderScanContinuations } from "@/features/flip-finder/server/manual-scan";
import { authorizeContinuationRequest } from "@/features/auth/github-actions-oidc";
import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Durable trigger for Finder source rows left pending by a bounded
 * serverless invocation. The route is intentionally cron-secret/OIDC
 * protected; it never starts a user-facing scan and never touches OLX's
 * separate queue.
 *
 * Responds immediately after authorization, before runFinderScanContinuations'
 * own claim-and-process loop (which runs until its own ~35s internal budget,
 * draining as many pending rows as fit) ever starts. A free external trigger
 * (e.g. cron-job.org) can close the connection well inside that window; the
 * real work is deferred via runAfterResponse so a fast ACK never means the
 * continuation didn't happen -- its outcome is only observable via
 * FINDER_CONTINUATION_RUN_COMPLETE/_FAILED in the function logs, not the
 * HTTP response body. Throughput across many pending rows now comes from
 * the trigger's own polling frequency (e.g. every few minutes), not from a
 * single invocation retrying internally.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!await authorizeContinuationRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  runAfterResponse(async () => {
    try {
      const result = await runFinderScanContinuations();
      console.info("FINDER_CONTINUATION_RUN_COMPLETE", result);
    } catch (error) {
      console.error("FINDER_CONTINUATION_RUN_FAILED", error instanceof Error ? error.message : error);
    }
  });
  return Response.json({ status: "accepted" }, { status: 202 });
}
