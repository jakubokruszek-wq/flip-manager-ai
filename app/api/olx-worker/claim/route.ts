import { authenticateOlxWorkerRequest } from "@/features/flip-finder/server/olx-worker-auth";
import { claimOlxJob } from "@/features/flip-finder/server/olx-jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateOlxWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const body = JSON.parse(auth.body) as unknown;
    const workerId = readString(body, "workerId");
    const job = await claimOlxJob(workerId);
    return Response.json({ job });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OLX_JOB_CLAIM_FAILED" }, { status: 400 });
  }
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value) || typeof value[key as keyof typeof value] !== "string") throw new Error("INVALID_PAYLOAD");
  return String(value[key as keyof typeof value]);
}
