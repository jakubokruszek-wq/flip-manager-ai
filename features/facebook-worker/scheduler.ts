import "server-only";

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { SearchFilter } from "@/features/flip-finder";
import { resolveFacebookListingIntent } from "@/features/facebook-watcher/facebook-intent";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { FACEBOOK_PRODUCTION_SOURCES, normalizeFacebookSourceUrl } from "@/features/collector/facebook-production";
import { enqueueFacebookJobs } from "./jobs";
import { activeJobDecision, orderSchedulerSources, schedulerCooldownMinutes, schedulerCycleDecision, withExclusiveSchedulerLock, type SchedulerSource } from "./scheduler-core";

type Row = Record<string, unknown>;
type SchedulerMarker = { automatic: true; cycleId: string; cycleStartedAt: string; cooldownMinutes: number; sourceId: string; plannedSourceIds: string[] };
const LOCK_NONCE = "facebook-automatic-scheduler-production";

export type FacebookSchedulerTickResult = {
  status: "LOCKED" | "IDLE" | "RUNNING" | "STARTED" | "ADVANCED" | "COMPLETED" | "ERROR";
  cycleId: string | null;
  activeSourceId: string | null;
  activeJobId: string | null;
  message: string | null;
};

export async function runFacebookSchedulerTick(now = new Date()): Promise<FacebookSchedulerTickResult> {
  const supabase = createFacebookWatcherAdminClient();
  try {
    const result = await withExclusiveSchedulerLock({
      acquire: () => acquireSchedulerLock(supabase, now),
      release: (owner) => releaseSchedulerLock(supabase, owner),
      task: () => runLockedSchedulerTick(supabase, now),
    });
    return result ?? output("LOCKED", null, null, null, null);
  } catch (error) {
    return output("ERROR", null, null, null, error instanceof Error ? error.message : "SCHEDULER_TICK_FAILED");
  }
}

async function runLockedSchedulerTick(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, now: Date): Promise<FacebookSchedulerTickResult> {
    const active = await activeBrowserJob(supabase);
    if (active) {
      const decision = activeJobDecision({ status: text(active.status) ?? "unknown", attempts: count(active.attempts), createdAt: text(active.created_at), heartbeatAt: text(active.heartbeat_at) }, now.getTime());
      if (decision === "FAIL_NEVER_CLAIMED") await failStuckJob(supabase, active, "COLLECTOR_NOT_AVAILABLE", "Facebook Collector did not claim the automatic job within 90 seconds", now);
      else if (decision === "FAIL_NO_PROGRESS") await failStuckJob(supabase, active, "COLLECTOR_PROGRESS_TIMEOUT", "Facebook Collector stopped renewing its lease/progress", now);
      else return output("RUNNING", text(active.scan_run_id), snapshotSourceId(active.group_snapshot), text(active.id), null);
    }

    const context = await schedulerContext(supabase, now);
    if (!context) return output("IDLE", null, null, null, "NO_ACTIVE_FACEBOOK_FILTER_OR_SOURCE");
    const history = await automaticScanHistory(supabase);
    const cycle = latestCycle(history);
    if (cycle) {
      await repairOrphanedCycleScans(supabase, cycle.scans, now);
      await refreshWatchedSourceHealth(supabase, cycle.scans, context.sources);
      const terminalSourceIds = unique(cycle.scans.filter((scan) => isTerminalSourceStatus(text(scan.status))).map((scan) => markerFromScan(scan)?.sourceId).filter((value): value is string => Boolean(value)));
      const decision = schedulerCycleDecision({ plan: cycle.plan, terminalSourceIds, cycleStartedAt: cycle.startedAt, cooldownMinutes: cycle.cooldownMinutes, nowMs: now.getTime() });
      if (decision.type === "ADVANCE") return enqueueAutomaticSource(context.filter, cycle.cycleId, cycle.startedAt, cycle.cooldownMinutes, cycle.plan, decision.source, terminalSourceIds.length > 0 ? "ADVANCED" : "STARTED");
      if (decision.type === "WAIT_COOLDOWN") return output("COMPLETED", cycle.cycleId, null, null, null);
    }

    const cycleId = randomUUID();
    return enqueueAutomaticSource(context.filter, cycleId, now.toISOString(), schedulerCooldownMinutes(context.filter.scanIntervalMinutes), context.sources, context.sources[0], "STARTED");
}

export async function getFacebookSchedulerDiagnostics() {
  const supabase = createFacebookWatcherAdminClient();
  const readClient = createSchedulerReadClient();
  const [jobsResult, sourcesResult, devicesResult, scansResult, batchesResult, filtersResult, lockResult] = await Promise.all([
    supabase.from("facebook_scan_jobs").select("id,status,scan_run_id,source_scan_id,group_snapshot,result_summary,error_code,error_message,worker_id,created_at,started_at,finished_at,heartbeat_at,consumer_type").eq("consumer_type", "BROWSER_EXTENSION").order("created_at", { ascending: false }).limit(500),
    supabase.from("watched_facebook_groups").select("id,name,url,enabled,last_checked_at,last_error,access_status").order("priority").order("name"),
    supabase.from("collector_devices").select("id,device_name,last_heartbeat_at,last_source_scan_at,last_captured_count,health_status,revoked_at").is("revoked_at", null).order("last_heartbeat_at", { ascending: false, nullsFirst: false }).limit(1),
    supabase.from("source_scans").select("id,scan_run_id,status,started_at,finished_at,scanned_count,matched_count,listings_created,listings_updated,error_message,filter_snapshot,warnings").eq("source", "facebook").order("started_at", { ascending: false }).limit(500),
    supabase.from("collector_scan_batches").select("scan_id,source_id,payload,result,received_at,status,error_message").order("received_at", { ascending: false }).limit(500),
    readClient.from("search_filters").select("id,sources,is_active,scan_interval_minutes").eq("is_active", true).limit(20),
    supabase.from("collector_request_nonces").select("device_id,created_at,expires_at").eq("nonce", LOCK_NONCE).maybeSingle(),
  ]);
  const error = jobsResult.error ?? sourcesResult.error ?? devicesResult.error ?? scansResult.error ?? batchesResult.error;
  if (error) throw new Error(`SCHEDULER_DIAGNOSTICS_FAILED: ${error.message}`);
  const jobs = records(jobsResult.data); const scans = attachJobMarkers(records(scansResult.data), jobs); const batches = records(batchesResult.data);
  const cycle = latestCycle(scans.filter((scan) => markerFromScan(scan)));
  const active = jobs.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const automaticScans = scans.filter((scan) => markerFromScan(scan));
  const recentBrowserJobs = jobs.slice(0, 10).map((job) => ({
    id: text(job.id), status: text(job.status), scanRunId: text(job.scan_run_id), sourceScanId: text(job.source_scan_id),
    sourceId: snapshotSourceId(job.group_snapshot), createdAt: text(job.created_at), startedAt: text(job.started_at),
    finishedAt: text(job.finished_at), heartbeatAt: text(job.heartbeat_at), errorCode: text(job.error_code),
  }));
  const device = record(devicesResult.data?.[0]);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const job of jobs) if (typeof job.status === "string" && job.status in counts) counts[job.status as keyof typeof counts] += 1;
  return {
    scheduler: { lastCycle: cycle ? latestTimestamp(cycle.scans.map((scan) => text(scan.finished_at))) : null, nextCycle: cycle ? new Date(Date.parse(cycle.startedAt) + cycle.cooldownMinutes * 60_000).toISOString() : null, cycleId: cycle?.cycleId ?? null, activeSource: active ? snapshotSourceId(active.group_snapshot) : null, cycleStatus: active ? "RUNNING" : cycle && cycle.scans.length < cycle.plan.length ? "WAITING" : "IDLE", automaticScanCount: automaticScans.length, latestAutomaticScan: automaticScans[0] ? { id: text(automaticScans[0].id), scanRunId: text(automaticScans[0].scan_run_id), status: text(automaticScans[0].status), sourceId: markerFromScan(automaticScans[0])?.sourceId ?? null, startedAt: text(automaticScans[0].started_at), finishedAt: text(automaticScans[0].finished_at), error: text(automaticScans[0].error_message) } : null,
      preflight: {
        lockStore: lockResult.error ? `ERROR:${lockResult.error.code ?? "QUERY_FAILED"}` : "PASS",
        lockPresent: Boolean(lockResult.data),
        lockExpiresAt: text(lockResult.data?.expires_at),
        activeFilterQuery: filtersResult.error ? `ERROR:${filtersResult.error.code ?? "QUERY_FAILED"}` : "PASS",
        activeFacebookFilterCount: filtersResult.error ? null : records(filtersResult.data).filter((filter) => strings(filter.sources).includes("facebook")).length,
      },
    },
    queue: counts,
    sources: records(sourcesResult.data).map((source) => sourceDiagnostics(source, scans, batches, jobs)),
    extension: { deviceName: text(device?.device_name), lastHeartbeat: text(device?.last_heartbeat_at), lastPoll: text(device?.last_heartbeat_at), lastClaim: latestTimestamp(jobs.map((job) => text(job.started_at))), currentJob: active && active.status === "running" ? text(active.id) : null, health: text(device?.health_status) },
    recentBrowserJobs,
  };
}

async function enqueueAutomaticSource(filter: SearchFilter, cycleId: string, startedAt: string, cooldownMinutes: number, plan: SchedulerSource[], source: SchedulerSource, status: "STARTED" | "ADVANCED"): Promise<FacebookSchedulerTickResult> {
  const marker: SchedulerMarker = { automatic: true, cycleId, cycleStartedAt: startedAt, cooldownMinutes, sourceId: source.sourceId, plannedSourceIds: plan.map((item) => item.sourceId) };
  const scheduledFilter = { ...filter, _facebookScheduler: marker } as SearchFilter;
  const queued = await enqueueFacebookJobs(scheduledFilter, cycleId, source.sourceId);
  const job = queued.jobs[0];
  if (!job) return output("ERROR", cycleId, source.sourceId, null, queued.failedGroups[0]?.error ?? queued.reasonCode ?? "FACEBOOK_QUEUE_JOB_NOT_CREATED");
  const supabase = createFacebookWatcherAdminClient();
  try {
    await stampAndVerifyAutomaticSource(supabase, job.jobId, job.sourceScanId, marker);
    return output(status, cycleId, source.sourceId, job.jobId, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SCHEDULER_MARKER_PERSIST_FAILED";
    const now = new Date().toISOString();
    await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now, error_code: "SCHEDULER_MARKER_PERSIST_FAILED", error_message: message }).eq("id", job.jobId).eq("status", "queued").eq("attempts", 0);
    await supabase.from("source_scans").update({ status: "failed", finished_at: now, error_message: `SCHEDULER_MARKER_PERSIST_FAILED: ${message}`.slice(0, 1_000) }).eq("id", job.sourceScanId).eq("status", "pending");
    return output("ERROR", cycleId, source.sourceId, job.jobId, message);
  }
}

async function stampAndVerifyAutomaticSource(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, jobId: string, sourceScanId: string, marker: SchedulerMarker): Promise<void> {
  const [jobResult, scanResult] = await Promise.all([
    supabase.from("facebook_scan_jobs").select("group_snapshot").eq("id", jobId).eq("status", "queued").maybeSingle(),
    supabase.from("source_scans").select("filter_snapshot,warnings").eq("id", sourceScanId).eq("status", "pending").maybeSingle(),
  ]);
  if (jobResult.error || scanResult.error || !jobResult.data || !scanResult.data) throw new Error("SCHEDULER_MARKER_TARGET_NOT_FOUND");
  const first = Array.isArray(jobResult.data.group_snapshot) ? record(jobResult.data.group_snapshot[0]) : null;
  const snapshot = jsonRecord(scanResult.data.filter_snapshot);
  if (!first || !snapshot) throw new Error("SCHEDULER_MARKER_TARGET_INVALID");
  const warning = `FACEBOOK_SCHEDULER_MARKER:${JSON.stringify(marker).slice(0, 2_000)}`;
  const warnings = unique([warning, ...strings(scanResult.data.warnings)]).slice(0, 100);
  const [jobUpdate, scanUpdate] = await Promise.all([
    supabase.from("facebook_scan_jobs").update({ group_snapshot: [{ ...first, _facebookScheduler: marker }] }).eq("id", jobId).eq("status", "queued").select("source_scan_id,group_snapshot").maybeSingle(),
    supabase.from("source_scans").update({ filter_snapshot: { ...snapshot, _facebookScheduler: marker }, warnings }).eq("id", sourceScanId).eq("status", "pending").select("id,filter_snapshot,warnings").maybeSingle(),
  ]);
  if (jobUpdate.error || scanUpdate.error || !jobUpdate.data || !scanUpdate.data) throw new Error("SCHEDULER_MARKER_WRITE_FAILED");
  const verifiedJob = { source_scan_id: jobUpdate.data.source_scan_id, group_snapshot: jobUpdate.data.group_snapshot } as Row;
  const verifiedScan = { id: scanUpdate.data.id, filter_snapshot: scanUpdate.data.filter_snapshot, warnings: scanUpdate.data.warnings } as Row;
  if (markerFromJob(verifiedJob)?.cycleId !== marker.cycleId || markerFromScan(verifiedScan)?.cycleId !== marker.cycleId) throw new Error("SCHEDULER_MARKER_VERIFY_FAILED");
}

async function schedulerContext(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, now: Date): Promise<{ filter: SearchFilter; sources: SchedulerSource[] } | null> {
  const readClient = createSchedulerReadClient();
  const [filtersResult, sourcesResult] = await Promise.all([
    readClient.from("search_filters").select("*").eq("is_active", true).order("updated_at", { ascending: false }),
    supabase.from("watched_facebook_groups").select("id,name,url,priority,created_at,enabled").eq("enabled", true),
  ]);
  if (filtersResult.error) throw new Error(`SCHEDULER_FILTER_QUERY_FAILED: ${filtersResult.error.message}`);
  if (sourcesResult.error) throw new Error(`SCHEDULER_SOURCE_QUERY_FAILED: ${sourcesResult.error.message}`);
  const filter = records(filtersResult.data).map(filterFromRow).find((candidate) => candidate.sources.includes("facebook"));
  if (!filter) return null;
  const approved = new Set(FACEBOOK_PRODUCTION_SOURCES.map((source) => `${source.sourceType}:${source.sourceId}`));
  const sources = orderSchedulerSources(records(sourcesResult.data).flatMap((source): SchedulerSource[] => {
    const url = text(source.url); const watchedSourceId = text(source.id);
    if (!url || !watchedSourceId) return [];
    const type = /^\/groups\//i.test(new URL(url).pathname) ? "GROUP" as const : "PROFILE" as const;
    const normalized = normalizeFacebookSourceUrl(url, type);
    if (!normalized || !approved.has(`${normalized.type}:${normalized.sourceId}`)) return [];
    return [{ watchedSourceId, sourceId: normalized.sourceId, name: text(source.name) ?? normalized.sourceId, url: normalized.url, type: normalized.type, priority: priority(source.priority), createdAt: text(source.created_at) ?? now.toISOString() }];
  }));
  return sources.length ? { filter, sources } : null;
}

function createSchedulerReadClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("SCHEDULER_READ_CLIENT_NOT_CONFIGURED");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function acquireSchedulerLock(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, now: Date): Promise<string | null> {
  const deviceResult = await supabase.from("collector_devices").select("id").is("revoked_at", null).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (deviceResult.error) throw new Error(`SCHEDULER_LOCK_DEVICE_QUERY_FAILED: ${deviceResult.error.message}`);
  const deviceId = text(deviceResult.data?.id);
  if (!deviceId) return null;
  const createdAt = now.toISOString();
  const stale = await supabase.from("collector_request_nonces").delete().eq("device_id", deviceId).eq("nonce", LOCK_NONCE).lt("expires_at", createdAt);
  if (stale.error) throw new Error(`SCHEDULER_LOCK_CLEANUP_FAILED: ${stale.error.message}`);
  const inserted = await supabase.from("collector_request_nonces").insert({ device_id: deviceId, nonce: LOCK_NONCE, created_at: createdAt, expires_at: new Date(now.getTime() + 5 * 60_000).toISOString() });
  if (!inserted.error) return `${deviceId}|${createdAt}`;
  if (inserted.error.code === "23505") return null;
  throw new Error(`SCHEDULER_LOCK_FAILED: ${inserted.error.message}`);
}

async function releaseSchedulerLock(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, owner: string): Promise<void> {
  const separator = owner.indexOf("|");
  const deviceId = separator > 0 ? owner.slice(0, separator) : "";
  const createdAt = separator > 0 ? owner.slice(separator + 1) : "";
  if (!deviceId || !createdAt) return;
  await supabase.from("collector_request_nonces").delete().eq("device_id", deviceId).eq("nonce", LOCK_NONCE).eq("created_at", createdAt);
}

async function activeBrowserJob(supabase: ReturnType<typeof createFacebookWatcherAdminClient>): Promise<Row | null> {
  const response = await supabase.from("facebook_scan_jobs").select("id,status,attempts,created_at,heartbeat_at,scan_run_id,source_scan_id,group_snapshot").eq("consumer_type", "BROWSER_EXTENSION").in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (response.error) throw new Error(`SCHEDULER_ACTIVE_JOB_QUERY_FAILED: ${response.error.message}`);
  return record(response.data);
}

async function failStuckJob(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, job: Row, code: string, message: string, now: Date) {
  const id = text(job.id); const sourceScanId = text(job.source_scan_id);
  if (!id || !sourceScanId) throw new Error("SCHEDULER_ACTIVE_JOB_INVALID");
  const failed = await supabase.from("facebook_scan_jobs").update({ status: "failed", finished_at: now.toISOString(), leased_until: null, error_code: code, error_message: message }).eq("id", id).eq("status", text(job.status)).select("id").maybeSingle();
  if (failed.error || !failed.data) return;
  await supabase.from("source_scans").update({ status: "failed", finished_at: now.toISOString(), error_message: `${code}: ${message}` }).eq("id", sourceScanId).in("status", ["pending", "running"]);
}

async function automaticScanHistory(supabase: ReturnType<typeof createFacebookWatcherAdminClient>): Promise<Row[]> {
  const [scansResult, jobsResult] = await Promise.all([
    supabase.from("source_scans").select("id,scan_run_id,status,started_at,finished_at,scanned_count,matched_count,listings_created,listings_updated,error_message,filter_snapshot,warnings").eq("source", "facebook").order("started_at", { ascending: false }).limit(500),
    supabase.from("facebook_scan_jobs").select("source_scan_id,group_snapshot").eq("consumer_type", "BROWSER_EXTENSION").order("created_at", { ascending: false }).limit(500),
  ]);
  const error = scansResult.error ?? jobsResult.error;
  if (error) throw new Error(`SCHEDULER_HISTORY_QUERY_FAILED: ${error.message}`);
  return attachJobMarkers(records(scansResult.data), records(jobsResult.data)).filter((scan) => markerFromScan(scan));
}

async function repairOrphanedCycleScans(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, scans: Row[], now: Date) {
  const unfinished = scans.filter((scan) => !isTerminalSourceStatus(text(scan.status)));
  for (const scan of unfinished) {
    const scanId = text(scan.id);
    if (!scanId) continue;
    const jobResult = await supabase.from("facebook_scan_jobs").select("status,error_code,error_message").eq("source_scan_id", scanId).maybeSingle();
    if (jobResult.error) throw new Error(`SCHEDULER_ORPHAN_JOB_QUERY_FAILED: ${jobResult.error.message}`);
    const job = record(jobResult.data);
    if (job && (job.status === "queued" || job.status === "running")) continue;
    const reason = text(job?.error_code) ?? text(job?.error_message) ?? (job?.status === "completed" ? "COLLECTOR_COMPLETED_WITHOUT_SOURCE_RESULT" : "SCHEDULER_JOB_MISSING");
    const update = await supabase.from("source_scans").update({ status: "failed", finished_at: now.toISOString(), error_message: reason }).eq("id", scanId).in("status", ["pending", "running"]);
    if (update.error) throw new Error(`SCHEDULER_ORPHAN_SOURCE_FINALIZE_FAILED: ${update.error.message}`);
    scan.status = "failed"; scan.finished_at = now.toISOString(); scan.error_message = reason;
  }
}

async function refreshWatchedSourceHealth(supabase: ReturnType<typeof createFacebookWatcherAdminClient>, scans: Row[], sources: SchedulerSource[]) {
  for (const scan of scans.filter((item) => isTerminalSourceStatus(text(item.status)))) {
    const sourceId = markerFromScan(scan)?.sourceId;
    const source = sources.find((item) => item.sourceId === sourceId);
    if (!source) continue;
    const failed = scan.status === "failed";
    const update = await supabase.from("watched_facebook_groups").update({
      access_status: failed ? "UNAVAILABLE" : "CONNECTED",
      last_checked_at: text(scan.finished_at) ?? new Date().toISOString(),
      last_error: failed ? text(scan.error_message) ?? "COLLECTOR_SOURCE_FAILED" : null,
    }).eq("id", source.watchedSourceId);
    if (update.error) throw new Error(`SCHEDULER_SOURCE_HEALTH_UPDATE_FAILED: ${update.error.message}`);
  }
}

function latestCycle(scans: Row[]): { cycleId: string; startedAt: string; cooldownMinutes: number; plan: SchedulerSource[]; scans: Row[] } | null {
  const latest = scans.find((scan) => markerFromScan(scan)); const marker = latest ? markerFromScan(latest) : null;
  if (!marker) return null;
  const cycleScans = scans.filter((scan) => markerFromScan(scan)?.cycleId === marker.cycleId);
  const plan = marker.plannedSourceIds.map((sourceId): SchedulerSource => ({ watchedSourceId: "", sourceId, name: sourceId, url: "", type: "GROUP", priority: "normal", createdAt: "" }));
  return { cycleId: marker.cycleId, startedAt: marker.cycleStartedAt, cooldownMinutes: schedulerCooldownMinutes(marker.cooldownMinutes), plan, scans: cycleScans };
}

function markerFromScan(scan: Row): SchedulerMarker | null {
  const snapshot = jsonRecord(scan.filter_snapshot);
  const marker = record(snapshot?._facebookScheduler) ?? schedulerMarkerFromWarnings(scan.warnings) ?? record(scan._schedulerMarker);
  if (marker?.automatic !== true || !text(marker.cycleId) || !text(marker.cycleStartedAt) || !text(marker.sourceId)) return null;
  const plannedSourceIds = strings(marker.plannedSourceIds);
  return plannedSourceIds.length ? { automatic: true, cycleId: String(marker.cycleId), cycleStartedAt: String(marker.cycleStartedAt), cooldownMinutes: schedulerCooldownMinutes(marker.cooldownMinutes), sourceId: String(marker.sourceId), plannedSourceIds } : null;
}

function attachJobMarkers(scans: Row[], jobs: Row[]): Row[] {
  const markers = new Map<string, SchedulerMarker>();
  for (const job of jobs) {
    const sourceScanId = text(job.source_scan_id);
    const marker = markerFromJob(job);
    if (sourceScanId && marker) markers.set(sourceScanId, marker);
  }
  return scans.map((scan) => {
    const marker = markers.get(text(scan.id) ?? "");
    return marker ? { ...scan, _schedulerMarker: marker } : scan;
  });
}

function markerFromJob(job: Row): SchedulerMarker | null {
  const first = Array.isArray(job.group_snapshot) ? record(job.group_snapshot[0]) : null;
  const marker = record(first?._facebookScheduler);
  if (!marker) return null;
  const plannedSourceIds = strings(marker.plannedSourceIds);
  return marker.automatic === true && text(marker.cycleId) && text(marker.cycleStartedAt) && text(marker.sourceId) && plannedSourceIds.length
    ? { automatic: true, cycleId: String(marker.cycleId), cycleStartedAt: String(marker.cycleStartedAt), cooldownMinutes: schedulerCooldownMinutes(marker.cooldownMinutes), sourceId: String(marker.sourceId), plannedSourceIds }
    : null;
}

function schedulerMarkerFromWarnings(value: unknown): SchedulerMarker | null {
  if (!Array.isArray(value)) return null;
  const warning = value.find((item): item is string => typeof item === "string" && item.startsWith("FACEBOOK_SCHEDULER_MARKER:"));
  if (!warning) return null;
  try { return record(JSON.parse(warning.slice("FACEBOOK_SCHEDULER_MARKER:".length))) as SchedulerMarker | null; } catch { return null; }
}

function jsonRecord(value: unknown): Row | null {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return record(value);
}

function sourceDiagnostics(source: Row, scans: Row[], batches: Row[], jobs: Row[]) {
  const url = text(source.url); const normalized = url ? normalizeFacebookSourceUrl(url) : null; const sourceId = normalized?.sourceId ?? null;
  const latestBatch = sourceId ? batches.find((batch) => batch.source_id === sourceId) : null; const payload = record(latestBatch?.payload);
  const posts = Array.isArray(payload?.posts) ? payload.posts.map(record).filter((post): post is Row => Boolean(post)) : [];
  const exact = posts.filter((post) => post.identityConfidence === "EXACT");
  const sell = exact.filter((post) => resolveFacebookListingIntent(text(post.text), null, null).intent === "SELL_PROPERTY").length;
  const latestScan = sourceId ? scans.find((scan) => markerFromScan(scan)?.sourceId === sourceId) : null;
  const latestJob = sourceId ? jobs.find((job) => snapshotSourceId(job.group_snapshot) === sourceId) : null;
  const summary = record(latestJob?.result_summary);
  return { source: text(source.name), sourceId, url, enabled: source.enabled === true, lastScanAt: text(latestScan?.started_at) ?? text(source.last_checked_at), lastSuccessAt: latestScan && (latestScan.status === "completed" || latestScan.status === "partial") ? text(latestScan.finished_at) : null, lastCanonicalCount: posts.length || count(latestScan?.scanned_count), lastExactCount: exact.length, lastSellCount: sell, review: reviewCount(summary), matched: count(latestScan?.matched_count), persisted: count(latestScan?.listings_created) + count(latestScan?.listings_updated), lastError: text(latestScan?.error_message) ?? text(source.last_error), consecutiveFailures: consecutiveFailures(sourceId, scans) };
}

function consecutiveFailures(sourceId: string | null, scans: Row[]): number { if (!sourceId) return 0; let failures = 0; for (const scan of scans.filter((item) => markerFromScan(item)?.sourceId === sourceId)) { if (scan.status === "failed") failures += 1; else break; } return failures; }
function reviewCount(summary: Row | null): number { const diagnostics = Array.isArray(summary?.persistenceDiagnostics) ? summary.persistenceDiagnostics.map(record).filter(Boolean) : []; return diagnostics.filter((item) => item?.decision === "REVIEW" || item?.lifecycleStatus === "REVIEW").length; }
function filterFromRow(row: Row): SearchFilter { return { id: String(row.id), name: text(row.name) ?? "Automatyczny Facebook", sources: strings(row.sources).filter((source): source is "facebook" | "olx" | "otodom" | "morizon" => ["facebook", "olx", "otodom", "morizon"].includes(source)), city: text(row.city), districts: strings(row.districts), priceMin: nullableNumber(row.price_min), priceMax: nullableNumber(row.price_max), areaMin: nullableNumber(row.area_min), areaMax: nullableNumber(row.area_max), rooms: numbers(row.rooms), floorMin: nullableNumber(row.floor_min), floorMax: nullableNumber(row.floor_max), excludeGroundFloor: row.exclude_ground_floor === true, excludeTopFloor: row.exclude_top_floor === true, buildingTypes: strings(row.building_types), ownershipTypes: strings(row.ownership_types), marketType: row.market_type === "primary" || row.market_type === "secondary" ? row.market_type : null, privateOnly: row.private_only === true, maxPricePerSqm: nullableNumber(row.max_price_per_sqm), requiredKeywords: strings(row.required_keywords), excludedKeywords: strings(row.excluded_keywords), minFlipScore: nullableNumber(row.min_flip_score), minEstimatedProfit: nullableNumber(row.min_estimated_profit), maxEstimatedRenovationCost: nullableNumber(row.max_estimated_renovation_cost), scanIntervalMinutes: count(row.scan_interval_minutes) || 1_440, isActive: row.is_active === true, lastScannedAt: text(row.last_scanned_at), createdAt: text(row.created_at) ?? "", updatedAt: text(row.updated_at) ?? "" }; }
function snapshotSourceId(value: unknown): string | null { const snapshot = Array.isArray(value) ? record(value[0]) : null; return text(snapshot?.sourceId) ?? text(snapshot?.id); }
function isTerminalSourceStatus(value: string | null): boolean { return value === "completed" || value === "partial" || value === "failed"; }
function priority(value: unknown): "high" | "normal" | "low" { return value === "high" || value === "low" ? value : "normal"; }
function output(status: FacebookSchedulerTickResult["status"], cycleId: string | null, activeSourceId: string | null, activeJobId: string | null, message: string | null): FacebookSchedulerTickResult { return { status, cycleId, activeSourceId, activeJobId, message }; }
function record(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function records(value: unknown): Row[] { return Array.isArray(value) ? value.map(record).filter((row): row is Row => Boolean(row)) : []; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function numbers(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : []; }
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function latestTimestamp(values: Array<string | null>): string | null { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
