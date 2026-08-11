import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { failFacebookJob, parseFacebookFailurePayload } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request); if (!auth.ok) return auth.response;
  try { await failFacebookJob(parseFacebookFailurePayload(JSON.parse(auth.body) as unknown)); return Response.json({ ok: true }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_FAIL_FAILED" }, { status: 409 }); }
}
