import { runFinderScanScheduler } from "@/features/flip-finder/server/finder-scheduler";
import { authorizeFinderSchedulerRequest } from "@/features/auth/github-actions-oidc";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Starts bounded Finder runs for filters whose own cadence has elapsed. The
 * hourly continuation endpoint remains a separate mechanism for the same
 * run's pending source rows.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!await authorizeFinderSchedulerRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runFinderScanScheduler();
    return Response.json(result, { status: 200 });
  } catch (error) {
    console.error("FINDER SCAN SCHEDULER FAILED:", error);
    return Response.json({ error: "Finder scheduler failed" }, { status: 500 });
  }
}
