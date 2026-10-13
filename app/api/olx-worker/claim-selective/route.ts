import { authenticateOlxWorkerRequest } from "@/features/flip-finder/server/olx-worker-auth";
import { claimSelectedOlxJob, parseClaimSelector } from "@/features/flip-finder/server/olx-selective-claim";

export const runtime = "nodejs";

/**
 * Same HMAC authentication as /api/olx-worker/claim, but claims only the
 * Finder job named by `jobId` or `filterId` (Cloudflare worker manual trial).
 * Non-matching jobs are never touched; an empty result means nothing matched.
 */
export async function POST(request: Request) {
  const auth = await authenticateOlxWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const { workerId, selector } = parseClaimSelector(JSON.parse(auth.body) as unknown);
    const job = await claimSelectedOlxJob(workerId, selector);
    return Response.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OLX_JOB_CLAIM_FAILED";
    return Response.json({ error: message }, { status: message === "OLX_SELECTIVE_CLAIM_UNAVAILABLE" ? 503 : 400 });
  }
}
