import { claimOrCreateRadarRun, resumeExistingRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";
import { createAdminClient } from "@/lib/supabase/admin";
import { radarSettingsSourcesWereFilteredToEmpty, readRadarSettings } from "@/features/price-radar/server/radar-settings";
import { latestRadarRun } from "@/features/price-radar/server/radar-run-status";
import { radarRunStartedTodayInWarsaw } from "@/features/price-radar/server/radar-scheduler";
import { RADAR_QUALITY_RULES_VERSION } from "@/features/price-radar/types";

/** Protected one-portion entry point used by the daily GitHub Actions scheduler. */
export const runtime = "nodejs";
export const maxDuration = 55;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE = new Set(["pending", "running"]);
const TERMINAL = new Set(["completed", "failed", "partial"]);

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "Brak CRON_SECRET w konfiguracji serwera." }, { status: 503 });
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  if (suppliedSecret !== process.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

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

  const admin = createAdminClient();
  if (typeof requestedRunId === "string") return continueExactRun(requestedRunId, admin);

  const { data: owners, error } = await admin.from("price_radar_settings").select("owner_id").order("updated_at", { ascending: true }).limit(100);
  if (error) return Response.json({ error: "RADAR_OWNER_READ_FAILED" }, { status: 500 });
  let waitingRun: { runId: string; status: "waiting"; retryAfterSeconds: number } | null = null;
  let waitingForOlxRun: { runId: string; status: "waiting_for_olx"; retryAfterSeconds: number } | null = null;
  let skippedForToday = false;
  let pausedRun: { runId: string; status: "paused_by_operator" } | null = null;
  for (const row of owners ?? []) {
    if (typeof row.owner_id !== "string") continue;
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

    const settings = await readRadarSettings(row.owner_id, admin);
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
  return Response.json({ status: "idle", message: "Brak właściciela Radaru gotowego do pobrania porcji." });
}

async function continueExactRun(runId: string, admin: ReturnType<typeof createAdminClient>) {
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
  return executePortion(row.owner_id, runId, resumed.run.leaseToken!, admin);
}

async function executePortion(ownerId: string, runId: string, leaseToken: string, admin: ReturnType<typeof createAdminClient>) {
  const portion = await runRadarCollectionPortion({ runId, ownerId, leaseToken }, admin);
  await admin.from("price_radar_settings").update({ updated_at: new Date().toISOString() }).eq("owner_id", ownerId);
  const waitingForOlx = portion.status === "running" && portion.sourceStatuses.olx === "running";
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
