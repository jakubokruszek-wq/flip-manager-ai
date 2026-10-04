import { runFinderScanContinuations } from "@/features/flip-finder/server/manual-scan";
import { authorizeContinuationRequest } from "@/features/auth/github-actions-oidc";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Durable hourly trigger for Finder source rows left pending by a bounded
 * serverless invocation. The route is intentionally cron-secret protected;
 * it never starts a user-facing scan and never touches OLX's separate queue.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!await authorizeContinuationRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runFinderScanContinuations();
    return Response.json(result, { status: result.status === "schema_unavailable" ? 503 : 200 });
  } catch (error) {
    console.error("FINDER SCAN CONTINUATION FAILED:", error);
    return Response.json({ error: "Continuation failed" }, { status: 500 });
  }
}
