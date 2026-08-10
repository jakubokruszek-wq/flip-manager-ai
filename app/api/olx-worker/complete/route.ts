import { authenticateOlxWorkerRequest } from "@/features/flip-finder/server/olx-worker-auth";
import { completeOlxJob, parseOlxCompletionPayload } from "@/features/flip-finder/server/olx-jobs";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  const auth = await authenticateOlxWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const payload = parseOlxCompletionPayload(JSON.parse(auth.body) as unknown);
    const result = await completeOlxJob(payload);
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OLX_COMPLETE_FAILED" }, { status: 409 });
  }
}
