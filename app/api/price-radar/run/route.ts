import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { claimOrCreateRadarRun, releaseRadarRunLease, requestRadarRunStop, requestRadarRunTermination, resumeExistingRadarRun, runRadarCollectionPortion, type RadarPortionResult } from "@/features/price-radar/server/collect";
import { scheduleRadarContinuation } from "@/features/price-radar/server/radar-continuation";
import { radarSettingsSourcesWereFilteredToEmpty, readRadarSettings } from "@/features/price-radar/server/radar-settings";
import { latestRadarRun } from "@/features/price-radar/server/radar-run-status";
import { RADAR_QUALITY_RULES_VERSION } from "@/features/price-radar/types";

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
    if (body && typeof body === "object" && "action" in body && body.action === "terminate") {
      if (!("runId" in body) || typeof body.runId !== "string" || !body.runId.trim()) {
        return Response.json({ code: "INVALID_TERMINATION_REQUEST" }, { status: 400 });
      }
      const terminated = await requestRadarRunTermination(operator.id, body.runId);
      if (terminated.kind === "blocked") {
        return Response.json({ code: terminated.reason, message: "Nie można definitywnie zakończyć tego przebiegu; odśwież jego stan." }, { status: 409 });
      }
      return Response.json({ runId: body.runId, status: terminated.kind });
    }
    if (body && typeof body === "object" && "action" in body && body.action === "stop") {
      if (!("runId" in body) || typeof body.runId !== "string" || !body.runId.trim()) {
        return Response.json({ code: "INVALID_STOP_REQUEST" }, { status: 400 });
      }
      const stopped = await requestRadarRunStop(operator.id, body.runId);
      if (stopped.kind === "blocked") {
        return Response.json({ code: stopped.reason, message: "The requested Radar run is no longer active." }, { status: 409 });
      }
      return Response.json({ runId: body.runId, status: stopped.kind });
    }
    const explicitlyStartingAfterTermination = Boolean(body && typeof body === "object" && "action" in body && body.action === "start_new");
    if (explicitlyStartingAfterTermination) {
      const latest = await latestRadarRun(operator.id);
      if (!latest?.userTerminatedAt) {
        return Response.json({ code: "RADAR_RUN_NOT_TERMINATED", message: "Nowy przebieg można uruchomić w ten sposób tylko po definitywnym zakończeniu poprzedniego." }, { status: 409 });
      }
    }
    if (!explicitlyStartingAfterTermination && body !== undefined && (!body || typeof body !== "object" || !("expectedRunId" in body) || typeof body.expectedRunId !== "string" || !body.expectedRunId.trim())) {
      return Response.json({ code: "INVALID_RESUME_REQUEST" }, { status: 400 });
    }
    const expectedRunId = !explicitlyStartingAfterTermination && body && typeof body === "object" && "expectedRunId" in body ? body.expectedRunId : null;
    if (typeof expectedRunId === "string") {
      const latest = await latestRadarRun(operator.id);
      const stoppedRun = latest?.status === "partial" && latest.errorMessage === "RADAR_STOPPED_BY_OPERATOR" && typeof latest.stopRequestedAt === "string";
      const stopStillPending = Boolean(latest?.stopRequestedAt && (latest.status === "pending" || latest.status === "running"));
      if (!latest || latest.id !== expectedRunId || latest.userTerminatedAt || stopStillPending || (latest.status !== "pending" && latest.status !== "running" && !stoppedRun)) {
        return Response.json({ code: "RADAR_RUN_CHANGED", message: "The requested Radar run is no longer resumable." }, { status: 409 });
      }
      const resumed = await resumeExistingRadarRun(operator.id, expectedRunId);
      if (resumed.kind === "blocked") {
        return Response.json({ code: resumed.reason, message: "The Radar run was not resumed; refresh its current state." }, { status: 409 });
      }
      if (!resumed.run.leaseToken) throw new Error("RADAR_LEASE_LOST");
      const portion = await runRadarCollectionPortion({ runId: resumed.run.id, ownerId: operator.id, leaseToken: resumed.run.leaseToken });
      await handOffToServer({ runId: resumed.run.id, ownerId: operator.id, leaseToken: resumed.run.leaseToken }, portion);
      return Response.json({ runId: resumed.run.id, ...portion });
    }
    const settings = await readRadarSettings(operator.id);
    if (await radarSettingsSourcesWereFilteredToEmpty(operator.id)) {
      return Response.json({ message: "Wybrane źródła są niedostępne (zostały wyłączone). Wybierz inne źródło w ustawieniach Radaru przed uruchomieniem zbierania." }, { status: 400 });
    }
    const claim = await claimOrCreateRadarRun(operator.id, settings.sources, undefined, {
      areaMin: settings.areaMin,
      areaMax: settings.areaMax,
      rooms: settings.rooms,
      minPricePerSqm: settings.minPricePerSqm,
      districts: settings.districts,
      qualityRulesVersion: RADAR_QUALITY_RULES_VERSION,
    });
    if (claim.kind === "blocked") {
      return Response.json({ message: "Inny przebieg Radaru już trwa." }, { status: 409 });
    }
    if (!claim.run.leaseToken) throw new Error("RADAR_LEASE_LOST");
    const portion = await runRadarCollectionPortion({ runId: claim.run.id, ownerId: operator.id, leaseToken: claim.run.leaseToken });
    await handOffToServer({ runId: claim.run.id, ownerId: operator.id, leaseToken: claim.run.leaseToken }, portion);
    return Response.json({ runId: claim.run.id, ...portion });
  } catch (error) {
    console.error("PRICE RADAR RUN ROUTE ERROR:", error);
    if (error instanceof Error && error.message === "RADAR_RUN_STOP_FAILED") {
      return Response.json({ code: "RADAR_RUN_STOP_FAILED", message: "Nie udało się zapisać żądania zatrzymania Radaru." }, { status: 500 });
    }
    if (error instanceof Error && error.message === "RADAR_RUN_TERMINATION_FAILED") {
      return Response.json({ code: "RADAR_RUN_TERMINATION_FAILED", message: "Nie udało się trwale zapisać zakończenia przebiegu Radaru." }, { status: 500 });
    }
    return Response.json({ message: "Nie udało się uruchomić zbierania Radaru." }, { status: 500 });
  }
}

/**
 * A portion started from the PWA must not depend on the phone staying awake:
 * release this request's own lease and let the server continue the same run.
 * If the hand-off cannot be sent, the open PWA or the scheduler still resumes
 * the same checkpoint once the (now released) lease is observed as expired.
 */
async function handOffToServer(input: { runId: string; ownerId: string; leaseToken: string }, portion: RadarPortionResult): Promise<void> {
  if (portion.status !== "running" || portion.sourceStatuses.olx === "running") return;
  try {
    if (await releaseRadarRunLease(input)) scheduleRadarContinuation({ runId: input.runId, hop: 1 });
  } catch {
    // The lease simply expires on its own; never fail the operator's request here.
  }
}
