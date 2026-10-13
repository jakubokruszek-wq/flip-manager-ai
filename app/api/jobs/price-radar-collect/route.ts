import { claimOrCreateRadarRun, releaseRadarRunLease, resumeExistingRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";
import { parseRadarContinuationHop, RADAR_CONTINUATION_HOP_HEADER, requestRadarContinuation, scheduleRadarContinuation } from "@/features/price-radar/server/radar-continuation";
import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";
import { createAdminClient } from "@/lib/supabase/admin";
import { radarSettingsSourcesWereFilteredToEmpty, readRadarSettings } from "@/features/price-radar/server/radar-settings";
import { latestRadarRun } from "@/features/price-radar/server/radar-run-status";
import { isRadarDailyScanDue, radarRunStartedTodayInWarsaw } from "@/features/price-radar/server/radar-scheduler";
import { RADAR_QUALITY_RULES_VERSION } from "@/features/price-radar/types";

/**
 * Protected one-portion entry point used by the GitHub Actions Radar scheduler.
 * Authorized by its own PRICE_RADAR_CRON_SECRET, deliberately separate from the
 * shared CRON_SECRET used by Finder/Facebook Watch -- a leak or rotation of
 * one never affects the other, and this endpoint accepts no other credential.
 *
 * A request carrying the continuation hop header is the server's own
 * self-continuation of one exact run (see radar-continuation.ts): it is
 * acknowledged with 202 at once and its portion runs after the response.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE = new Set(["pending", "running"]);
const TERMINAL = new Set(["completed", "failed", "partial"]);

export async function POST(request: Request) {
  if (!process.env.PRICE_RADAR_CRON_SECRET) return Response.json({ error: "Brak PRICE_RADAR_CRON_SECRET w konfiguracji serwera." }, { status: 503 });
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  if (suppliedSecret !== process.env.PRICE_RADAR_CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown = {};
  const rawBody = await request.text();
  if (rawBody.trim()) {
    try { body = JSON.parse(rawBody); }
    catch { return Response.json({ error: "Invalid request body." }, { status: 400 }); }
  }
  const requestedRunId = isRecord(body) && body.runId !== undefined ? body.runId : null;
  if (requestedRunId !== null && (typeof requestedRunId !== "string" || !RUN_ID.test(requestedRunId))) {
    return Response.json({ error: "Invalid Radar run ID." }, { status: 400 });
  }

  const rawHop = request.headers.get(RADAR_CONTINUATION_HOP_HEADER);
  if (rawHop !== null) {
    const hop = parseRadarContinuationHop(rawHop);
    if (hop === null || typeof requestedRunId !== "string") return Response.json({ error: "Invalid Radar continuation." }, { status: 400 });
    runAfterResponse(async () => {
      try {
        await continueExactRun(requestedRunId, createAdminClient(), { hop, awaitNext: true });
      } catch (error) {
        console.error("RADAR_CONTINUATION_PORTION_FAILED", { runId: requestedRunId, hop, message: error instanceof Error ? error.message : "unknown" });
      }
    });
    return Response.json({ runId: requestedRunId, status: "accepted" }, { status: 202 });
  }

  const admin = createAdminClient();
  if (typeof requestedRunId === "string") return continueExactRun(requestedRunId, admin);

  const { data: owners, error } = await admin.from("price_radar_settings").select("owner_id").order("updated_at", { ascending: true }).limit(100);
  if (error) return Response.json({ error: "RADAR_OWNER_READ_FAILED" }, { status: 500 });
  let waitingRun: { runId: string; status: "waiting"; retryAfterSeconds: number } | null = null;
  let waitingForOlxRun: { runId: string; status: "waiting_for_olx"; retryAfterSeconds: number } | null = null;
  let skippedForToday = false;
  let skippedBeforeSchedule = false;
  let skippedBecauseDisabled = false;
  let pausedRun: { runId: string; status: "paused_by_operator" } | null = null;
  for (const row of owners ?? []) {
    if (typeof row.owner_id !== "string") continue;
    const settings = await readRadarSettings(row.owner_id, admin);
    if (!settings.automaticScanEnabled) { skippedBecauseDisabled = true; continue; }
    // A saved selection containing only disabled sources must not silently
    // turn into a full-portfolio run when the automatic scheduler calls in.
    if (await radarSettingsSourcesWereFilteredToEmpty(row.owner_id, admin)) continue;
    const latest = await latestRadarRun(row.owner_id, admin);
    if (latest) {
      if (latest.stopRequestedAt || (latest.status === "partial" && latest.errorMessage === "RADAR_STOPPED_BY_OPERATOR")) {
        pausedRun ??= { runId: latest.id, status: "paused_by_operator" };
        continue;
      }
      if (latest.status === "pending" || latest.status === "running") {
        const leaseUntil = latest.leaseUntil ? Date.parse(latest.leaseUntil) : 0;
        if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
          waitingRun ??= { runId: latest.id, status: "waiting", retryAfterSeconds: Math.max(5, Math.ceil((leaseUntil - Date.now()) / 1000) + 2) };
          continue;
        }
        const resumed = await resumeExistingRadarRun(row.owner_id, latest.id, admin);
        if (resumed.kind === "blocked") {
          if (resumed.reason === "olx_queue_owns_source") waitingForOlxRun ??= { runId: latest.id, status: "waiting_for_olx", retryAfterSeconds: 300 };
          else waitingRun ??= { runId: latest.id, status: "waiting", retryAfterSeconds: 80 };
          continue;
        }
        return executePortion(row.owner_id, resumed.run.id, resumed.run.leaseToken!, admin);
      }
      if (radarRunStartedTodayInWarsaw(latest.startedAt)) {
        skippedForToday = true;
        continue;
      }
    }

    if (!isRadarDailyScanDue({ enabled: true, time: settings.automaticScanTime, lastStartedAt: latest?.startedAt })) {
      skippedBeforeSchedule = true;
      continue;
    }
    const claim = await claimOrCreateRadarRun(row.owner_id, settings.sources, admin, {
      areaMin: settings.areaMin,
      areaMax: settings.areaMax,
      rooms: settings.rooms,
      minPricePerSqm: settings.minPricePerSqm,
      districts: settings.districts,
      qualityRulesVersion: RADAR_QUALITY_RULES_VERSION,
    });
    if (claim.kind === "blocked" || !claim.run.leaseToken) {
      waitingRun ??= latest
        ? { runId: latest.id, status: "waiting", retryAfterSeconds: 80 }
        : null;
      continue;
    }
    return executePortion(row.owner_id, claim.run.id, claim.run.leaseToken, admin);
  }
  if (waitingForOlxRun) return Response.json(waitingForOlxRun);
  if (waitingRun) return Response.json(waitingRun);
  if (pausedRun) return Response.json(pausedRun);
  if (skippedForToday) return Response.json({ status: "already_ran_today" });
  if (skippedBeforeSchedule) return Response.json({ status: "not_due" });
  if (skippedBecauseDisabled) return Response.json({ status: "automation_disabled" });
  return Response.json({ status: "idle", message: "Brak właściciela Radaru gotowego do pobrania porcji." });
}

type ContinuationMode = { hop: number; awaitNext: boolean };

async function continueExactRun(runId: string, admin: ReturnType<typeof createAdminClient>, chain?: ContinuationMode) {
  const { data: row, error } = await admin.from("price_radar_runs").select("*").eq("id", runId).maybeSingle();
  if (error) return Response.json({ error: "RADAR_RUN_READ_FAILED" }, { status: 500 });
  if (!row || typeof row.owner_id !== "string") return Response.json({ error: "RADAR_RUN_NOT_FOUND" }, { status: 404 });
  if (row.stop_requested_at) return Response.json({ runId, status: "paused_by_operator" });
  if (row.user_terminated_at || TERMINAL.has(String(row.status))) {
    return Response.json({
      runId,
      status: row.user_terminated_at ? "user_terminated" : row.status,
      terminal: true,
      scannedCount: Number(row.scanned_count ?? 0),
      qualifiedCount: Number(row.qualified_count ?? 0),
      sourceStatuses: row.source_statuses ?? {},
      sourceErrors: isRecord(row.checkpoint) && isRecord(row.checkpoint.sourceErrors) ? row.checkpoint.sourceErrors : {},
    });
  }
  if (!ACTIVE.has(String(row.status))) return Response.json({ runId, status: "run_not_active", terminal: true });
  // A server hop only ever follows a portion that already ran for this exact
  // run (manual or scheduled), so finishing it does not depend on the daily
  // automation switch; STOP/termination above remain the operator's controls.
  if (!chain) {
    const settings = await readRadarSettings(row.owner_id, admin);
    if (!settings.automaticScanEnabled) return Response.json({ runId, status: "automation_disabled" });
  }
  const leaseUntil = typeof row.lease_until === "string" ? Date.parse(row.lease_until) : 0;
  if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) {
    return Response.json({ runId, status: "waiting", retryAfterSeconds: Math.max(5, Math.ceil((leaseUntil - Date.now()) / 1000) + 2) });
  }

  const resumed = await resumeExistingRadarRun(row.owner_id, runId, admin);
  if (resumed.kind === "blocked") {
    if (resumed.reason === "olx_queue_owns_source") return Response.json({ runId, status: "waiting_for_olx", retryAfterSeconds: 300 });
    if (resumed.reason === "lease_active") return Response.json({ runId, status: "waiting", retryAfterSeconds: 80 });
    // A concurrent worker may have finished or paused the same run after the
    // read above. Do not claim a replacement run on this exact-ID path.
    const { data: current } = await admin.from("price_radar_runs").select("status,stop_requested_at,user_terminated_at").eq("id", runId).eq("owner_id", row.owner_id).maybeSingle();
    if (current?.stop_requested_at) return Response.json({ runId, status: "paused_by_operator" });
    if (current?.user_terminated_at || (current && TERMINAL.has(String(current.status)))) return Response.json({ runId, status: current.user_terminated_at ? "user_terminated" : current.status, terminal: true });
    return Response.json({ runId, status: "run_changed" }, { status: 409 });
  }
  return executePortion(row.owner_id, runId, resumed.run.leaseToken!, admin, chain);
}

async function executePortion(ownerId: string, runId: string, leaseToken: string, admin: ReturnType<typeof createAdminClient>, chain?: ContinuationMode) {
  const portion = await runRadarCollectionPortion({ runId, ownerId, leaseToken }, admin);
  await admin.from("price_radar_settings").update({ updated_at: new Date().toISOString() }).eq("owner_id", ownerId);
  const waitingForOlx = portion.status === "running" && portion.sourceStatuses.olx === "running";
  // OLX is owned by its separate worker queue; every other unfinished portal
  // continues on the server without waiting for this lease to expire.
  if (portion.status === "running" && !waitingForOlx && await releaseRadarRunLease({ runId, ownerId, leaseToken }, admin)) {
    const next = { runId, hop: (chain?.hop ?? 0) + 1 };
    if (chain?.awaitNext) await requestRadarContinuation(next);
    else scheduleRadarContinuation(next);
  }
  return Response.json({
    runId,
    ...portion,
    ...(portion.status === "running" ? { retryAfterSeconds: waitingForOlx ? 300 : 80 } : {}),
    ...(waitingForOlx ? { status: "waiting_for_olx" } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Vercel Cron can invoke a job with GET; the secured scheduler uses POST.
export const GET = POST;
