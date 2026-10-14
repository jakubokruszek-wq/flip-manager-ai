import { authenticateOlxWorkerRequest } from "@/features/flip-finder/server/olx-worker-auth";
import { claimScheduledOlxJob, parseScheduledClaimBody } from "@/features/flip-finder/server/olx-scheduled-claim";

export const runtime = "nodejs";

/**
 * Same HMAC authentication as /api/olx-worker/claim. Hands the scheduled
 * Cloudflare Worker at most one automatic Finder OLX job (see
 * claim_scheduled_finder_olx_job); `{ job: null, reason }` says why not.
 */
export async function POST(request: Request) {
  const auth = await authenticateOlxWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const { workerId, usage } = parseScheduledClaimBody(JSON.parse(auth.body) as unknown);
    return Response.json(await claimScheduledOlxJob(workerId, usage));
  } catch (error) {
    const message = error instanceof Error ? error.message : "OLX_JOB_CLAIM_FAILED";
    return Response.json({ error: message }, { status: message === "OLX_SCHEDULED_CLAIM_UNAVAILABLE" ? 503 : 400 });
  }
}
