import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { qualifyRadarCandidate, type QualificationCandidate } from "@/features/price-radar/qualification";
import { createRadarDistrictAiBudget, suggestRadarDistrictWithAi, type RadarDistrictAiBudget } from "@/features/price-radar/server/radar-district-ai";
import { DEFAULT_RADAR_DISTRICTS, type RadarDistrictQueueItem } from "@/features/price-radar/types";

type Row = Record<string, unknown>;

const QUEUE_SELECT = "id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,building_type,market_type,renovation_status,content_hash,cross_source_identity,published_at,source_updated_at,collected_at,first_seen_at,last_seen_at,raw_payload,status,suggested_district,suggestion_source,suggestion_evidence,assigned_district,assigned_at,rejected_at";

/** True only for the exact PostgREST/Postgres "relation/function not found" codes this optional, not-yet-applied migration produces. Any other error is a real failure and must still throw. */
function isSchemaUnavailable(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") return true;
  const message = typeof error.message === "string" ? error.message : "";
  return /price_radar_district_queue|upsert_price_radar_district_queue_candidate|assign_price_radar_district_queue_candidate|set_price_radar_district_queue_rejection/u.test(message)
    && /does not exist|not find|schema cache/iu.test(message);
}

export type DistrictQueueCandidate = {
  source: string;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number;
  area: number;
  rooms: number | null;
  city: string;
  contentHash: string;
  crossSourceIdentity: string | null;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  rawPayload: Record<string, unknown>;
};

/**
 * Saves (or refreshes) a candidate that is fully qualified except for its
 * district. Called from the normal collection path (collect.ts, the OLX
 * worker) right after assessRadarDistrictOnlyCandidate() confirms
 * eligibility -- never a second scraper, never run on its own schedule.
 * Idempotent by (owner, source, externalListingId): a rescan refreshes the
 * dwelling snapshot but the database function itself never touches
 * status, assigned_district, assigned_at, or rejected_at, so an operator's prior decision always
 * survives a reimport untouched.
 *
 * Silently reports unavailability (never throws) when the optional
 * migration has not been applied yet -- a scan must keep working exactly
 * as before even though this feature does nothing until a human applies
 * supabase/migrations/20261011120000_add_radar_district_queue.sql.
 *
 * Also computes (or reuses) a best-effort AI district suggestion. The
 * EXISTING row's content_hash is checked first: when it matches this
 * candidate's own content_hash, the prior suggestion is carried forward
 * unchanged and the AI is never re-invoked -- a reimport of an unchanged
 * listing must not spend a call just to arrive at the same answer. Only
 * a genuinely new row, or one whose content actually changed since it
 * was last seen, triggers a fresh suggestion attempt, and that attempt
 * is itself bounded by `aiBudget` (one shared budget per collection
 * portion/job, never a per-candidate allowance) and by the AI resolver's
 * own timeout. A missing/failed/budget-exhausted suggestion is never an
 * error -- the candidate is queued regardless, simply without one.
 */
export async function upsertPendingDistrictCandidate(
  supabase: SupabaseClient,
  ownerId: string,
  candidate: DistrictQueueCandidate,
  confirmed: { buildingType: string; marketType: string; renovationStatus: string; pricePerSqm: number },
  seenAt: string,
  aiBudget: RadarDistrictAiBudget = createRadarDistrictAiBudget(),
  suggest: typeof suggestRadarDistrictWithAi = suggestRadarDistrictWithAi,
): Promise<{ ok: true; queueId: string } | { ok: false; reason: "schema_unavailable" | "error" }> {
  const { data: existing, error: readError } = await supabase.from("price_radar_district_queue")
    .select("content_hash,suggested_district,suggestion_source,suggestion_evidence")
    .eq("owner_id", ownerId).eq("source", candidate.source).eq("external_listing_id", candidate.externalListingId)
    .maybeSingle();
  if (readError && isSchemaUnavailable(readError)) return { ok: false, reason: "schema_unavailable" };

  let suggestion: { district: string | null; source: "gis" | "ai" | null; evidence: string | null };
  const existingRow = existing as Row | null;
  if (existingRow && existingRow.content_hash === candidate.contentHash) {
    suggestion = {
      district: nullableString(existingRow.suggested_district),
      source: existingRow.suggestion_source === "gis" || existingRow.suggestion_source === "ai" ? existingRow.suggestion_source : null,
      evidence: nullableString(existingRow.suggestion_evidence),
    };
  } else if (aiBudget.tryConsume()) {
    const aiSuggestion = await suggest(toQualificationCandidate({
      source: candidate.source, external_listing_id: candidate.externalListingId,
      original_url: candidate.originalUrl, normalized_url: candidate.normalizedUrl,
      title: candidate.title, description: candidate.description,
      content_hash: candidate.contentHash, building_type: confirmed.buildingType, market_type: confirmed.marketType,
      city: candidate.city, price: candidate.price, area: candidate.area, price_per_sqm: confirmed.pricePerSqm, rooms: candidate.rooms,
    }, null));
    suggestion = aiSuggestion ? { district: aiSuggestion.district, source: "ai", evidence: aiSuggestion.evidence } : { district: null, source: null, evidence: null };
  } else {
    suggestion = { district: null, source: null, evidence: null };
  }

  const { data, error } = await supabase.rpc("upsert_price_radar_district_queue_candidate", {
    p_owner_id: ownerId,
    p_candidate: {
      source: candidate.source,
      external_listing_id: candidate.externalListingId,
      original_url: candidate.originalUrl,
      normalized_url: candidate.normalizedUrl,
      title: candidate.title,
      description: candidate.description,
      price: candidate.price,
      area: candidate.area,
      price_per_sqm: confirmed.pricePerSqm,
      rooms: candidate.rooms,
      city: candidate.city,
      building_type: confirmed.buildingType,
      market_type: confirmed.marketType,
      renovation_status: confirmed.renovationStatus,
      content_hash: candidate.contentHash,
      cross_source_identity: candidate.crossSourceIdentity,
      published_at: candidate.publishedAt,
      source_updated_at: candidate.sourceUpdatedAt,
      collected_at: seenAt,
      last_seen_at: seenAt,
      raw_payload: candidate.rawPayload,
      suggested_district: suggestion.district,
      suggestion_source: suggestion.source,
      suggestion_evidence: suggestion.evidence,
    },
  });
  if (error) {
    if (isSchemaUnavailable(error)) return { ok: false, reason: "schema_unavailable" };
    return { ok: false, reason: "error" };
  }
  return typeof data === "string" ? { ok: true, queueId: data } : { ok: false, reason: "error" };
}

export type RadarDistrictQueueRead = { available: boolean; pending: RadarDistrictQueueItem[]; assigned: RadarDistrictQueueItem[]; rejected: RadarDistrictQueueItem[] };

/** Reads every queue row for the owner, grouped by status. Never throws for an unapplied migration -- reports an empty, unavailable queue instead. */
export async function getRadarDistrictQueue(ownerId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarDistrictQueueRead> {
  const { data, error } = await supabase.from("price_radar_district_queue").select(QUEUE_SELECT).eq("owner_id", ownerId).order("first_seen_at", { ascending: false });
  if (error) {
    if (isSchemaUnavailable(error)) return { available: false, pending: [], assigned: [], rejected: [] };
    throw new Error("Nie udało się odczytać kolejki dzielnic Radaru.");
  }
  const rows = (Array.isArray(data) ? data : []).map(toQueueItem).filter((item): item is RadarDistrictQueueItem => item !== null);
  return {
    available: true,
    pending: rows.filter((item) => item.status === "pending"),
    assigned: rows.filter((item) => item.status === "assigned"),
    rejected: rows.filter((item) => item.status === "rejected"),
  };
}

export type AssignDistrictResult =
  | { ok: true; listingId: string }
  | { ok: false; reason: "schema_unavailable" | "not_found" | "invalid_district" | "no_longer_qualifies"; detail?: string };

/**
 * Re-qualifies the CURRENT queue row with the operator-chosen district
 * before persisting anything -- never trusts whatever confirmed fields
 * were true when the candidate was first queued. A save error (schema
 * missing, row gone, or the candidate no longer actually qualifies) is
 * always reported as a failure, never silently treated as success.
 */
export async function assignRadarDistrictQueueCandidate(
  ownerId: string,
  queueId: string,
  district: string,
  assignedBy: string,
  qualityRulesVersion: 1 | 2 = 2,
  supabase: SupabaseClient = createAdminClient(),
): Promise<AssignDistrictResult> {
  if (!(DEFAULT_RADAR_DISTRICTS as readonly string[]).includes(district)) return { ok: false, reason: "invalid_district" };

  const { data: row, error: readError } = await supabase.from("price_radar_district_queue").select(QUEUE_SELECT).eq("id", queueId).eq("owner_id", ownerId).maybeSingle();
  if (readError) {
    if (isSchemaUnavailable(readError)) return { ok: false, reason: "schema_unavailable" };
    return { ok: false, reason: "not_found" };
  }
  if (!row) return { ok: false, reason: "not_found" };

  const candidate = toQualificationCandidate(row as Row, district);
  const outcome = qualifyRadarCandidate(candidate, qualityRulesVersion);
  if (!outcome.qualified) {
    return { ok: false, reason: "no_longer_qualifies", detail: outcome.reason };
  }

  const { data, error } = await supabase.rpc("assign_price_radar_district_queue_candidate", {
    p_owner_id: ownerId,
    p_queue_id: queueId,
    p_district: district,
    p_assigned_by: assignedBy,
    p_confirmed: { building_type: outcome.buildingType, market_type: outcome.marketType, renovation_status: outcome.renovationStatus, price_per_sqm: outcome.pricePerSqm },
  });
  if (error) {
    if (isSchemaUnavailable(error)) return { ok: false, reason: "schema_unavailable" };
    if (error.message === "QUEUE_CANDIDATE_NOT_FOUND") return { ok: false, reason: "not_found" };
    if (error.message === "INVALID_DISTRICT") return { ok: false, reason: "invalid_district" };
    return { ok: false, reason: "not_found" };
  }
  if (typeof data !== "string") return { ok: false, reason: "not_found" };
  return { ok: true, listingId: data };
}

export type RejectDistrictQueueResult = { ok: true } | { ok: false; reason: "schema_unavailable" | "not_found" };

/** Reject a pending candidate, or undo a rejection back to pending. Never touches an already-assigned row -- correcting an assigned district is done by assigning again, not by rejecting. */
export async function setRadarDistrictQueueRejection(ownerId: string, queueId: string, rejected: boolean, supabase: SupabaseClient = createAdminClient()): Promise<RejectDistrictQueueResult> {
  const { data, error } = await supabase.rpc("set_price_radar_district_queue_rejection", { p_owner_id: ownerId, p_queue_id: queueId, p_rejected: rejected });
  if (error) {
    if (isSchemaUnavailable(error)) return { ok: false, reason: "schema_unavailable" };
    return { ok: false, reason: "not_found" };
  }
  return data === true ? { ok: true } : { ok: false, reason: "not_found" };
}

function toQualificationCandidate(row: Row, district: string | null): QualificationCandidate {
  return {
    source: String(row.source), externalListingId: String(row.external_listing_id),
    originalUrl: String(row.original_url), normalizedUrl: String(row.normalized_url),
    title: nullableString(row.title), description: nullableString(row.description),
    price: nullableNumber(row.price), area: nullableNumber(row.area), pricePerSqm: nullableNumber(row.price_per_sqm),
    rooms: nullableNumber(row.rooms), city: nullableString(row.city), district,
    buildingType: nullableString(row.building_type), marketType: nullableString(row.market_type), propertyType: null,
    rawPayload: { ...(isRecord(row.raw_payload) ? row.raw_payload : {}), detailVerified: true },
    contentHash: String(row.content_hash),
  };
}

function toQueueItem(row: Row): RadarDistrictQueueItem | null {
  const id = nullableString(row.id);
  const source = nullableString(row.source);
  const externalListingId = nullableString(row.external_listing_id);
  const originalUrl = nullableString(row.original_url);
  const normalizedUrl = nullableString(row.normalized_url);
  const city = nullableString(row.city);
  const buildingType = row.building_type === "blok" || row.building_type === "apartamentowiec" ? row.building_type : null;
  const marketType = row.market_type === "primary" || row.market_type === "secondary" ? row.market_type : null;
  const renovationStatus = row.renovation_status === "fresh_renovation" || row.renovation_status === "turnkey_finish" ? row.renovation_status : null;
  const price = nullableNumber(row.price);
  const area = nullableNumber(row.area);
  const pricePerSqm = nullableNumber(row.price_per_sqm);
  const firstSeenAt = nullableString(row.first_seen_at);
  const lastSeenAt = nullableString(row.last_seen_at);
  const collectedAt = nullableString(row.collected_at);
  const status = row.status === "pending" || row.status === "assigned" || row.status === "rejected" ? row.status : null;
  if (!id || !source || !externalListingId || !originalUrl || !normalizedUrl || !city || !buildingType || !marketType || !renovationStatus || price === null || area === null || pricePerSqm === null || !firstSeenAt || !lastSeenAt || !collectedAt || !status) {
    return null;
  }
  return {
    id, source: source as RadarDistrictQueueItem["source"], externalListingId, originalUrl, normalizedUrl,
    title: nullableString(row.title), description: nullableString(row.description),
    price, area, pricePerSqm, rooms: nullableNumber(row.rooms), city, buildingType, marketType, renovationStatus,
    qualityCategory: marketType === "primary" || renovationStatus === "fresh_renovation" ? "fresh_renovation" : "ready_high_standard",
    firstSeenAt, lastSeenAt, publishedAt: nullableString(row.published_at), sourceUpdatedAt: nullableString(row.source_updated_at), collectedAt,
    status,
    suggestedDistrict: nullableString(row.suggested_district),
    suggestionSource: row.suggestion_source === "gis" || row.suggestion_source === "ai" ? row.suggestion_source : null,
    suggestionEvidence: nullableString(row.suggestion_evidence),
    assignedDistrict: nullableString(row.assigned_district), assignedAt: nullableString(row.assigned_at), rejectedAt: nullableString(row.rejected_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
