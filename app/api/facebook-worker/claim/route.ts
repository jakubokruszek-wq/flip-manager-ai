import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { claimFacebookJob } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request); if (!auth.ok) return auth.response;
  try {
    const body = JSON.parse(auth.body) as unknown;
    if (!body || typeof body !== "object" || !("workerId" in body) || typeof body.workerId !== "string") throw new Error("INVALID_PAYLOAD");
    return Response.json({ job: await claimFacebookJob(body.workerId) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_JOB_CLAIM_FAILED" }, { status: 400 }); }
}

