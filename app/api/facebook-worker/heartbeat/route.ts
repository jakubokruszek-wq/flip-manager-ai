import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { heartbeatFacebookJob } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request); if (!auth.ok) return auth.response;
  try { const body = parse(JSON.parse(auth.body)); return Response.json({ ok: true, leasedUntil: await heartbeatFacebookJob(body) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_HEARTBEAT_FAILED" }, { status: 409 }); }
}

function parse(value: unknown) { if (!value || typeof value !== "object") throw new Error("INVALID_PAYLOAD"); const row = value as Record<string, unknown>; for (const key of ["jobId", "leaseToken", "workerId"] as const) if (typeof row[key] !== "string" || !row[key]) throw new Error("INVALID_PAYLOAD"); return { jobId: String(row.jobId), leaseToken: String(row.leaseToken), workerId: String(row.workerId) }; }

