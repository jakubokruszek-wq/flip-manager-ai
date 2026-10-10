import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { claimOrCreateRadarRun, resumeExistingRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";
import { readRadarSettings } from "@/features/price-radar/server/radar-settings";
import { latestRadarRun } from "@/features/price-radar/server/radar-run-status";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Manual/operator-triggered Radar collection portion. Claims (or resumes)
 * the single allowed run and processes one time-boxed portion of it --
 * exactly the same function a daily cron would call, just invoked by hand.
 * No cron currently calls this route; see the draft note in
 * supabase/migrations/20261008000000_create_price_radar.sql and this
 * mission's final report for the exact, not-yet-added vercel.json entry.
 */
export async function GET() {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    return Response.json({ run: await latestRadarRun(operator.id) });
  } catch {
    return Response.json({ message: "Nie udało się odczytać stanu Radaru." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const body = await request.json().catch(() => undefined) as unknown;
    if (body !== undefined && (!body || typeof body !== "object" || !("expectedRunId" in body) || typeof body.expectedRunId !== "string" || !body.expectedRunId.trim())) {
      return Response.json({ code: "INVALID_RESUME_REQUEST" }, { status: 400 });
    }
    const expectedRunId = body && typeof body === "object" && "expectedRunId" in body ? body.expectedRunId : null;
    if (typeof expectedRunId === "string") {
      const latest = await latestRadarRun(operator.id);
      if (!latest || latest.id !== expectedRunId || (latest.status !== "pending" && latest.status !== "running")) {
        return Response.json({ code: "RADAR_RUN_CHANGED", message: "The requested Radar run is no longer resumable." }, { status: 409 });
      }
      const resumed = await resumeExistingRadarRun(operator.id, expectedRunId);
      if (resumed.kind === "blocked") {
        return Response.json({ code: resumed.reason, message: "The Radar run was not resumed; refresh its current state." }, { status: 409 });
      }
      if (!resumed.run.leaseToken) throw new Error("RADAR_LEASE_LOST");
      const portion = await runRadarCollectionPortion({ runId: resumed.run.id, ownerId: operator.id, leaseToken: resumed.run.leaseToken });
      return Response.json({ runId: resumed.run.id, ...portion });
    }
    const settings = await readRadarSettings(operator.id);
    const claim = await claimOrCreateRadarRun(operator.id, settings.sources, undefined, {
      areaMin: settings.areaMin,
      areaMax: settings.areaMax,
      rooms: settings.rooms,
    });
    if (claim.kind === "blocked") {
      return Response.json({ message: "Inny przebieg Radaru już trwa." }, { status: 409 });
    }
    if (!claim.run.leaseToken) throw new Error("RADAR_LEASE_LOST");
    const portion = await runRadarCollectionPortion({ runId: claim.run.id, ownerId: operator.id, leaseToken: claim.run.leaseToken });
    return Response.json({ runId: claim.run.id, ...portion });
  } catch (error) {
    console.error("PRICE RADAR RUN ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się uruchomić zbierania Radaru." }, { status: 500 });
  }
}
