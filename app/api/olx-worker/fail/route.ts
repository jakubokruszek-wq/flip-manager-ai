import { authenticateOlxWorkerRequest } from "@/features/flip-finder/server/olx-worker-auth";
import { failOlxJob } from "@/features/flip-finder/server/olx-jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateOlxWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const body = parseBody(auth.body);
    await failOlxJob(body);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OLX_FAIL_FAILED" }, { status: 409 });
  }
}

function parseBody(text: string) {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") throw new Error("INVALID_PAYLOAD");
  const row = value as Record<string, unknown>;
  for (const key of ["jobId", "leaseToken", "workerId", "errorCode", "errorMessage"] as const) if (typeof row[key] !== "string" || !row[key]) throw new Error("INVALID_PAYLOAD");
  return { jobId: String(row.jobId), leaseToken: String(row.leaseToken), workerId: String(row.workerId), errorCode: String(row.errorCode), errorMessage: String(row.errorMessage) };
}
