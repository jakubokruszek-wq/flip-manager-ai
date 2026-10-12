import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assessRadarDistrictOnlyCandidate, normalizeRadarQualificationRejections, qualifyRadarCandidate, recordRadarQualificationRejection } from "@/features/price-radar/qualification";
import { persistRadarListing } from "@/features/price-radar/server/persist-radar-listing";
import { radarDistrictQueueFailureWarning, rejectedRadarDistrictQueueExternalIds, upsertPendingDistrictCandidate } from "@/features/price-radar/server/radar-district-queue";
import { rejectedRadarVerificationExternalIds } from "@/features/price-radar/server/radar-verification-queue";
import { createRadarDistrictAiBudget } from "@/features/price-radar/server/radar-district-ai";
import type { RadarCheckpoint, RadarRunStatus } from "@/features/price-radar/types";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import { createAdminClient } from "@/lib/supabase/admin";

export const RADAR_STOPPED_BY_OPERATOR = "RADAR_STOPPED_BY_OPERATOR";

type JobInput = { jobId: string; jobLeaseToken: string; workerId: string; ownerId: string; runId: string; radarLeaseToken: string };
type OlxPayload = { fetched: number; listings: SourceListing[]; warnings: string[]; durationMs: number };

/** Saves OLX results into Radar-owned rows only and atomically checkpoints the OLX queue task. */
export async function finishRadarOlxJob(input: JobInput, payload: OlxPayload | { errorCode: string; errorMessage: string }, client: SupabaseClient = createAdminClient()): Promise<{ source: "olx"; status: "completed" | "failed"; fetched: number; qualified: number }> {
  const { data: runRow, error: runError } = await client.from("price_radar_runs").select("checkpoint,source_statuses,scanned_count,qualified_count,status,lease_token,lease_until,stop_requested_at")
    .eq("id", input.runId).eq("owner_id", input.ownerId).maybeSingle();
  if (runError || !runRow || runRow.status !== "running" || runRow.lease_token !== input.radarLeaseToken || !isFuture(runRow.lease_until)) throw new Error("RADAR_LEASE_LOST");
  const checkpoint = parseCheckpoint(runRow.checkpoint);
  if (checkpoint.sourceQueue[checkpoint.currentSourceIndex] !== "olx" || checkpoint.sourceStatuses.olx !== "running") throw new Error("RADAR_OLX_CHECKPOINT_MISMATCH");

  if (runRow.stop_requested_at) {
    checkpoint.sourceStatuses.olx = "pending";
    const { data, error } = await client.rpc("finalize_price_radar_olx_job", {
      p_owner_id: input.ownerId, p_run_id: input.runId, p_radar_lease_token: input.radarLeaseToken,
      p_job_id: input.jobId, p_worker_id: input.workerId, p_job_lease_token: input.jobLeaseToken,
      p_checkpoint: checkpoint, p_source_statuses: checkpoint.sourceStatuses,
      p_scanned_count: Number(runRow.scanned_count ?? 0), p_qualified_count: Number(runRow.qualified_count ?? 0),
      p_run_status: "partial", p_error_message: RADAR_STOPPED_BY_OPERATOR,
      p_job_status: "failed", p_result_summary: { source: "olx", status: "stopped", retainedResults: true },
      p_error_code: RADAR_STOPPED_BY_OPERATOR, p_job_error_message: "Operator stopped this Radar run",
    });
    if (error || data !== true) throw new Error("RADAR_LEASE_LOST");
    return { source: "olx", status: "failed", fetched: 0, qualified: 0 };
  }

  let fetched = 0;
  let qualified = 0;
  let queueStatus: "completed" | "failed";
  let sourceStatus: "completed" | "failed" | "partial";
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let resultSummary: Record<string, unknown>;
  if ("errorCode" in payload) {
    queueStatus = "failed";
    sourceStatus = "failed";
    errorCode = payload.errorCode.slice(0, 100);
    errorMessage = payload.errorMessage.replace(/[\r\n\t]/g, " ").slice(0, 1000);
    checkpoint.sourceErrors.olx = `${errorCode}: ${errorMessage}`;
    resultSummary = { source: "olx", status: "failed", fetched: 0, normalized: 0, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: 0, durationMs: 0, errorCode, errorMessage, warnings: [], matchDiagnostics: {} };
  } else {
    queueStatus = "completed";
    fetched = payload.fetched;
    const sourceErrors = payload.warnings.map((warning) => warning.replace(/[\r\n\t]/g, " ").slice(0, 500));
    const districtQueueWarnings: string[] = [];
    let districtQueueCandidates = 0;
    const districtAiBudget = createRadarDistrictAiBudget();
    const olxExternalIds = payload.listings.map((listing) => listing.externalListingId);
    const [rejectedVerificationIds, rejectedDistrictIds] = await Promise.all([
      rejectedRadarVerificationExternalIds(client, input.ownerId, "olx", olxExternalIds),
      rejectedRadarDistrictQueueExternalIds(client, input.ownerId, "olx", olxExternalIds),
    ]);
    for (const listing of payload.listings) {
      const raw = listing.rawPayload ?? {};
      const olxCandidate = {
        source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
        title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
        rooms: listing.rooms, city: listing.city, district: listing.district, buildingType: listing.buildingType,
        marketType: resolveOlxMarketType(raw),
        propertyType: typeof raw.propertyType === "string" ? raw.propertyType : null,
        rawPayload: raw, contentHash: listing.contentHash,
      };
      const outcome = qualifyRadarCandidate(olxCandidate, checkpoint.searchCriteria?.qualityRulesVersion ?? 1, undefined, checkpoint.searchCriteria?.minPricePerSqm, checkpoint.searchCriteria?.districts, checkpoint.searchCriteria?.areaMin, checkpoint.searchCriteria?.areaMax);
      if (!outcome.qualified) {
        // See collect.ts for the same rule: only a candidate missing ONLY
        // its district (every other criterion already confirmed) ever
        // reaches the manual district-assignment queue.
        if (outcome.reason === "district_not_confirmed") {
          const districtAssessment = assessRadarDistrictOnlyCandidate(olxCandidate, checkpoint.searchCriteria?.qualityRulesVersion ?? 1, checkpoint.searchCriteria?.minPricePerSqm, checkpoint.searchCriteria?.districts, checkpoint.searchCriteria?.areaMin, checkpoint.searchCriteria?.areaMax);
          if (districtAssessment.eligible) {
            districtQueueCandidates += 1;
            const queueResult = await upsertPendingDistrictCandidate(client, input.ownerId, {
              source: "olx", externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
              title: listing.title, description: listing.description, price: listing.price!, area: listing.area!, rooms: listing.rooms,
              city: listing.city!, contentHash: listing.contentHash, crossSourceIdentity: listing.crossSourceIdentity ?? null,
              publishedAt: listing.publishedAt ?? null, sourceUpdatedAt: sourceDate(raw),
              rawPayload: raw,
            }, districtAssessment.confirmed, new Date().toISOString(), districtAiBudget);
            if (!queueResult.ok) {
              const warning = radarDistrictQueueFailureWarning(queueResult.reason);
              districtQueueWarnings.push(warning);
              checkpoint.sourceWarnings ??= {};
              checkpoint.sourceWarnings.olx = [...new Set([...(checkpoint.sourceWarnings.olx ?? []), warning])].slice(0, 20);
            }
            continue;
          }
        }
        recordRadarQualificationRejection(checkpoint.qualificationRejections ??= {}, "olx", outcome.reason);
        continue;
      }
      if (rejectedVerificationIds.has(listing.externalListingId) || rejectedDistrictIds.has(listing.externalListingId)) {
        recordRadarQualificationRejection(checkpoint.qualificationRejections ??= {}, "olx", "previously_rejected_by_operator");
        continue;
      }
      const crossSourceIdentity = listing.crossSourceIdentity ?? null;
      await persistRadarListing(client, {
        ...outcome, source: "olx", externalListingId: listing.externalListingId, originalUrl: listing.originalUrl,
        normalizedUrl: listing.normalizedUrl, title: listing.title, description: listing.description,
        price: listing.price!, area: listing.area!, rooms: listing.rooms, city: listing.city!, contentHash: listing.contentHash,
        publishedAt: listing.publishedAt ?? null, sourceUpdatedAt: sourceDate(raw), crossSourceIdentity, rawPayload: raw,
      }, { ownerId: input.ownerId, runId: input.runId, leaseToken: input.radarLeaseToken, seenAt: new Date().toISOString() });
      qualified += 1;
    }
    sourceStatus = sourceErrors.length ? "failed" : districtQueueWarnings.length ? "partial" : "completed";
    if (sourceErrors.length) checkpoint.sourceErrors.olx = sourceErrors.join("; ").slice(0, 1000);
    else delete checkpoint.sourceErrors.olx;
    resultSummary = { source: "olx", status: "completed", fetched, normalized: qualified, matched: 0, listingsCreated: 0, newMatches: 0, updated: 0, priceDrops: 0, rejected: Math.max(0, fetched - qualified - districtQueueCandidates), durationMs: payload.durationMs, errorCode: null, errorMessage: null, warnings: [...sourceErrors, ...districtQueueWarnings], qualificationRejections: checkpoint.qualificationRejections, matchDiagnostics: {} };
  }

  checkpoint.sourceStatuses.olx = sourceStatus;
  checkpoint.currentSourceIndex += 1;
  const statuses = { ...checkpoint.sourceStatuses };
  const pending = checkpoint.currentSourceIndex < checkpoint.sourceQueue.length;
  const failed = Object.values(statuses).filter((status) => status === "failed").length;
  const partial = Object.values(statuses).filter((status) => status === "partial").length;
  const runStatus: RadarRunStatus = pending ? "running" : failed === checkpoint.sourceQueue.length ? "failed" : failed > 0 || partial > 0 ? "partial" : "completed";
  const runErrors = Object.entries(checkpoint.sourceErrors).map(([source, message]) => `${source}: ${message}`).join("\n").slice(0, 2000) || null;
  const { data, error } = await client.rpc("finalize_price_radar_olx_job", {
    p_owner_id: input.ownerId, p_run_id: input.runId, p_radar_lease_token: input.radarLeaseToken,
    p_job_id: input.jobId, p_worker_id: input.workerId, p_job_lease_token: input.jobLeaseToken,
    p_checkpoint: checkpoint, p_source_statuses: statuses,
    p_scanned_count: Number(runRow.scanned_count ?? 0) + fetched,
    p_qualified_count: Number(runRow.qualified_count ?? 0) + qualified,
    p_run_status: runStatus, p_error_message: runErrors,
    p_job_status: queueStatus, p_result_summary: resultSummary, p_error_code: errorCode, p_job_error_message: errorMessage,
  });
  if (error || data !== true) throw new Error(error?.message === "OLX_JOB_LEASE_LOST" ? "OLX_JOB_LEASE_LOST" : "RADAR_LEASE_LOST");
  return { source: "olx", status: queueStatus, fetched, qualified };
}

function parseCheckpoint(value: unknown): RadarCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RADAR_CHECKPOINT_INVALID");
  const row = value as Partial<RadarCheckpoint>;
  if (!Array.isArray(row.sourceQueue) || !Number.isInteger(row.currentSourceIndex) || !row.sourceStatuses || !row.sourceErrors || !row.perSourceCursor) throw new Error("RADAR_CHECKPOINT_INVALID");
  return { ...(row as RadarCheckpoint), qualificationRejections: normalizeRadarQualificationRejections(row.qualificationRejections) };
}
function isFuture(value: unknown): boolean { return typeof value === "string" && Date.parse(value) > Date.now(); }
function sourceDate(raw: Record<string, unknown>): string | null {
  for (const key of ["updatedAt", "modifiedAt", "updated_at", "modified_at"]) {
    const value = raw[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

function resolveOlxMarketType(raw: Record<string, unknown>): string | null {
  const params = Array.isArray(raw.params) ? raw.params : [];
  const marketParam = params.find((value) => isRecord(value) && value.key === "market");
  const paramValue = isRecord(marketParam)
    ? typeof marketParam.normalizedValue === "string" ? marketParam.normalizedValue : typeof marketParam.value === "string" ? marketParam.value : null
    : null;
  const sourceValue = typeof raw.marketType === "string" ? raw.marketType : paramValue;
  const value = sourceValue?.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pl-PL").trim();
  if (!value) return null;
  if (/\b(primary|pierwotn\p{L}*|dewelopersk\p{L}*)\b/iu.test(value)) return "primary";
  if (/\b(secondary|resale|wtorn\p{L}*)\b/iu.test(value)) return "secondary";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
