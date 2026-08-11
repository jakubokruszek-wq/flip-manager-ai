import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { parseFacebookCompletionPayload } from "@/features/facebook-worker/completion";
import { completeFacebookJob } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request); if (!auth.ok) return auth.response;
  try { return Response.json({ ok: true, result: await completeFacebookJob(parseFacebookCompletionPayload(JSON.parse(auth.body) as unknown)) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_COMPLETE_FAILED" }, { status: 409 }); }
}

