import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasCategoryBFinishEvidence, inspectRadarFinishEvidence, preflightRadarCandidateRejection, qualifyRadarCandidate, resolveKnownRadarDistrict, type QualificationCandidate } from "@/features/price-radar/qualification";
import { createRadarDistrictAiBudget, suggestRadarDistrictWithAi, type RadarDistrictAiBudget } from "@/features/price-radar/server/radar-district-ai";
import { DEFAULT_RADAR_DISTRICTS, type RadarQualityCategory, type RadarSource, type RadarVerificationDecision, type RadarVerificationQueueItem } from "@/features/price-radar/types";

type Row = Record<string, unknown>;
const SELECT = "id,source,external_listing_id,original_url,normalized_url,title,status,source_snapshot,confirmed_fields,missing_fields,contradictory_fields,routing_reasons,field_evidence,suggested_district,suggestion_evidence,operator_decision,decision_at,rejected_at,first_seen_at,last_seen_at";
const REVIEWABLE_REASONS = new Set([
  "detail_not_confirmed", "detail_conflict", "price_missing", "area_missing", "price_is_not_total_offer_price",
  "price_is_starting_price", "price_per_sqm_invalid", "district_not_confirmed", "city_not_lodz",
  "apartment_not_confirmed", "building_type_not_confirmed", "market_type_not_confirmed",
  "renovation_not_confirmed_fresh_full", "turnkey_not_confirmed",
]);

export type RadarVerificationCandidateInput = {
  listing: PropertySourceListing;
  reason: string;
  detailUnconfirmedFields?: string[];
  detailContradictoryFields?: string[];
  seenAt: string;
};

export function isReviewableRadarVerificationCandidate(input: RadarVerificationCandidateInput): boolean {
  const { listing } = input;
  if (!REVIEWABLE_REASONS.has(input.reason)) return false;
  if (!listing.originalUrl || !/^https?:\/\//iu.test(listing.originalUrl) || !listing.externalListingId) return false;
  const knownCity = listing.city?.trim();
  if (knownCity && !/^(?:Łódź|Lodz)(?:\b|[,/ -]|$)/iu.test(knownCity)) return false;
  if (listing.rawPayload.detailIdentity === "mismatch" || listing.rawPayload.detailActive === false) return false;
  const preflightReason = preflightRadarCandidateRejection({
    title: listing.title, description: listing.description, buildingType: listing.buildingType,
    propertyType: typeof listing.rawPayload.propertyType === "string" ? listing.rawPayload.propertyType : null,
    rawPayload: listing.rawPayload,
  });
  // Starting/per-square-metre amounts need an operator's total-price check;
  // unlike other preflight results, they are not hard property exclusions.
  if (preflightReason && preflightReason !== "price_is_not_total_offer_price" && preflightReason !== "price_is_starting_price") return false;
  const title = listing.title ?? "";
  const routeAndTitle = `${title} ${listing.originalUrl}`;
  // Only a concrete apartment offer from the Radar's sale search is reviewable.
  // A page advertising a whole investment or a different property class is
  // excluded by preflightRadarCandidateRejection above.
  const apartmentEvidence = listing.rawPayload.radarSearchScope === "apartment-sale"
    ? /mieszkan\p{L}*|apartament\p{L}*/iu.test(routeAndTitle)
    : /mieszkan\p{L}*|apartament\p{L}*/iu.test(title);
  return apartmentEvidence;
}

export function buildRadarVerificationSnapshot(input: RadarVerificationCandidateInput): Record<string, unknown> {
  const { listing } = input;
  const raw = listing.rawPayload;
  const description = sanitizeSourceText(listing.description, 1_200);
  const title = sanitizeSourceText(listing.title, 240);
  const details = [title, description].filter(Boolean).join(". ");
  const price = positive(listing.price);
  const area = positive(listing.area);
  const rooms = positive(listing.rooms);
  const issueAliases: Record<string, string> = {
    total_price: "total_price", price: "total_price", price_missing: "total_price", area: "area", rooms: "rooms", city_lodz: "city_lodz",
    district: "district", building_type: "building_type", market_type: "market_type", apartment_sale: "apartment_sale",
    renovation_completion: "standard", renovation_recency: "standard", move_in_readiness: "standard", turnkey_finish: "standard", finish_evidence: "standard",
  };
  const unconfirmedFields = new Set((input.detailUnconfirmedFields ?? []).map((field) => issueAliases[field] ?? field));
  const contradictoryFields = new Set([
    ...(Array.isArray(raw.detailContradictions) ? raw.detailContradictions.filter((value): value is string => typeof value === "string") : []),
    ...(input.detailContradictoryFields ?? []),
  ].map((field) => issueAliases[field] ?? field));
  const totalPriceConfirmed = price !== null
    && listing.rawPayload.priceIsStartingAt !== true
    && listing.rawPayload.priceKind !== "from"
    && listing.rawPayload.priceUnit !== "per_sqm"
    && input.reason !== "price_is_not_total_offer_price"
    && input.reason !== "price_is_starting_price"
    && !unconfirmedFields.has("total_price")
    && !contradictoryFields.has("total_price");
  const marketType = typeof raw.marketType === "string" ? raw.marketType : null;
  const standardText = `${title ?? ""} ${description ?? ""}`;
  const finish = inspectRadarFinishEvidence(standardText);
  const qualityCategory: RadarQualityCategory | null = marketType === "secondary" && finish.freshFullRenovation && finish.fullRenovation && finish.moveInReady
    ? "fresh_renovation"
    : hasCategoryBFinishEvidence(title, description) ? "ready_high_standard" : null;
  const confirmedFields: string[] = [];
  const missingFields: string[] = [];
  const values: Record<string, unknown> = {
    total_price: totalPriceConfirmed ? price : null, area, rooms,
    city_lodz: listing.city === "Łódź" ? listing.city : null,
    district: resolveKnownRadarDistrict(listing.district),
    building_type: isBuildingType(listing.buildingType) ? listing.buildingType : null,
    market_type: marketType === "primary" || marketType === "secondary" ? marketType : null,
    standard: qualityCategory,
    apartment_sale: raw.radarSearchScope === "apartment-sale" || raw.propertyType === "apartment" ? "mieszkanie na sprzedaż" : null,
  };
  for (const [field, value] of Object.entries(values)) (value === null ? missingFields : confirmedFields).push(field);
  for (const field of unconfirmedFields) {
    const index = confirmedFields.indexOf(field);
    if (index >= 0) confirmedFields.splice(index, 1);
    missingFields.push(field);
  }
  for (const field of contradictoryFields) {
    const index = confirmedFields.indexOf(field);
    if (index >= 0) confirmedFields.splice(index, 1);
  }
  const uniqueMissing = [...new Set(missingFields)];
  const fieldEvidence: Record<string, string> = {};
  for (const [field, patterns] of Object.entries(EVIDENCE_PATTERNS)) {
    const quote = findQuote(details, [patterns]);
    const value = values[field];
    if (quote) fieldEvidence[field] = quote;
    else if (value !== null && value !== undefined) fieldEvidence[field] = field === "apartment_sale" && raw.radarSearchScope === "apartment-sale"
      ? "Zakres wyszukiwania portalu obejmował mieszkania na sprzedaż; operator nadal potwierdza konkretną ofertę."
      : `Pole odczytane z danych portalu: ${String(value).slice(0, 100)}`;
    else fieldEvidence[field] = "Brak jednoznacznego potwierdzenia w zapisanych danych oferty.";
  }
  const publishedAt = validDate(raw.publishedAt ?? raw.datePublished ?? raw.datePosted);
  const sourceUpdatedAt = validDate(raw.updatedAt ?? raw.modifiedAt ?? raw.updated_at ?? raw.modified_at);
  return {
    description,
    price,
    pricePerSqm: totalPriceConfirmed && area !== null && confirmedFields.includes("area") && !contradictoryFields.has("area") ? price! / area : null,
    area,
    rooms,
    city: listing.city,
    district: listing.district,
    buildingType: listing.buildingType,
    marketType,
    qualityCategory,
    publishedAt,
    sourceUpdatedAt,
    collectedAt: input.seenAt,
    contentHash: listing.contentHash,
    crossSourceIdentity: listing.crossSourceIdentity ?? null,
    sourceHttpStatus: isRecord(raw.detailResponse) && typeof raw.detailResponse.httpStatus === "number" ? raw.detailResponse.httpStatus : null,
    finalUrl: isRecord(raw.detailResponse) && typeof raw.detailResponse.finalUrl === "string" ? raw.detailResponse.finalUrl : null,
    sourceIdentity: isRecord(raw.detailResponse) && typeof raw.detailResponse.identity === "string" ? raw.detailResponse.identity : null,
    rawPayload: {
      priceIsStartingAt: raw.priceIsStartingAt === true,
      priceKind: typeof raw.priceKind === "string" ? raw.priceKind : null,
      priceUnit: typeof raw.priceUnit === "string" ? raw.priceUnit : null,
      radarSearchScope: raw.radarSearchScope === "apartment-sale" ? "apartment-sale" : null,
      propertyType: typeof raw.propertyType === "string" ? raw.propertyType.slice(0, 40) : null,
    },
    confirmedFields: [...new Set(confirmedFields)],
    missingFields: uniqueMissing,
    contradictoryFields: [...contradictoryFields],
    routingReasons: [...new Set([input.reason, ...[...contradictoryFields].map((field) => `contradiction:${field}`), ...uniqueMissing.map((field) => `missing:${field}`)])],
    fieldEvidence,
    suggestedDistrict: null,
    suggestionEvidence: null,
  };
}

export async function upsertPendingRadarVerificationCandidate(
  supabase: SupabaseClient,
  ownerId: string,
  input: RadarVerificationCandidateInput,
  aiBudget: RadarDistrictAiBudget = createRadarDistrictAiBudget(),
  suggest: typeof suggestRadarDistrictWithAi = suggestRadarDistrictWithAi,
): Promise<{ ok: true; queueId: string } | { ok: false; reason: "schema_unavailable" | "error" }> {
  if (!isReviewableRadarVerificationCandidate(input)) return { ok: false, reason: "error" };
  const snapshot = buildRadarVerificationSnapshot(input);
  const { data: existing, error: readError } = await supabase.from("price_radar_verification_queue")
    .select("source_snapshot,suggested_district,suggestion_evidence")
    .eq("owner_id", ownerId).eq("source", input.listing.source).eq("external_listing_id", input.listing.externalListingId).maybeSingle();
  if (readError && isSchemaUnavailable(readError)) return { ok: false, reason: "schema_unavailable" };
  if (readError) return { ok: false, reason: "error" };
  const prior = asRow(existing);
  const priorSnapshot = asRow(prior?.source_snapshot);
  let suggestion: { district: string | null; evidence: string | null } = { district: nullableString(prior?.suggested_district), evidence: nullableString(prior?.suggestion_evidence) };
  if ((!prior || priorSnapshot.contentHash !== snapshot.contentHash) && aiBudget.tryConsume()) {
    try {
      const result = await suggest(toQualificationCandidate(input.listing, null));
      if (result) suggestion = { district: result.district, evidence: result.evidence };
    } catch {
      // Suggestions are optional; they never block operator review.
    }
  }
  snapshot.suggestedDistrict = suggestion.district;
  snapshot.suggestionEvidence = suggestion.evidence;
  const { data, error } = await supabase.rpc("upsert_price_radar_verification_candidate", {
    p_owner_id: ownerId,
    p_candidate: {
      source: input.listing.source,
      external_listing_id: input.listing.externalListingId,
      original_url: input.listing.originalUrl,
      normalized_url: input.listing.normalizedUrl,
      title: sanitizeSourceText(input.listing.title, 240),
      source_snapshot: snapshot,
      confirmed_fields: snapshot.confirmedFields,
      missing_fields: snapshot.missingFields,
      contradictory_fields: snapshot.contradictoryFields,
      routing_reasons: snapshot.routingReasons,
      field_evidence: snapshot.fieldEvidence,
      suggested_district: suggestion.district,
      suggestion_evidence: sanitizeSourceText(suggestion.evidence, 220),
      first_seen_at: input.seenAt,
      last_seen_at: input.seenAt,
    },
  });
  if (error) return { ok: false, reason: isSchemaUnavailable(error) ? "schema_unavailable" : "error" };
  return typeof data === "string" ? { ok: true, queueId: data } : { ok: false, reason: "error" };
}

export type RadarVerificationQueueRead = { available: boolean; pending: RadarVerificationQueueItem[]; confirmed: RadarVerificationQueueItem[]; rejected: RadarVerificationQueueItem[] };

export async function getRadarVerificationQueue(ownerId: string, supabase: SupabaseClient = createAdminClient()): Promise<RadarVerificationQueueRead> {
  const { data, error } = await supabase.from("price_radar_verification_queue").select(SELECT).eq("owner_id", ownerId).order("last_seen_at", { ascending: false });
  if (error) {
    if (isSchemaUnavailable(error)) return { available: false, pending: [], confirmed: [], rejected: [] };
    throw new Error("Nie udało się odczytać kolejki weryfikacji Radaru.");
  }
  const rows = (Array.isArray(data) ? data : []).map(toQueueItem).filter((item): item is RadarVerificationQueueItem => item !== null);
  return { available: true, pending: rows.filter((item) => item.status === "pending"), confirmed: rows.filter((item) => item.status === "confirmed"), rejected: rows.filter((item) => item.status === "rejected") };
}

export type ResolveRadarVerificationResult = { ok: true; listingId: string } | { ok: false; reason: "schema_unavailable" | "not_found" | "invalid_decision" | "no_longer_qualifies"; detail?: string };

export async function resolveRadarVerificationCandidate(
  ownerId: string,
  queueId: string,
  decision: RadarVerificationDecision,
  supabase: SupabaseClient = createAdminClient(),
  // The operator's CURRENT saved threshold/district selection, read by the
  // caller -- reading it in this module would import radar-settings.ts ->
  // settings.ts, which itself imports RADAR_SOURCES back from collect.ts,
  // which imports THIS module (a real circular-import TDZ crash, confirmed
  // 2026-10-12).
  minPricePerSqm?: number | null,
  selectedDistricts?: readonly string[] | null,
): Promise<ResolveRadarVerificationResult> {
  const { data: row, error } = await supabase.from("price_radar_verification_queue").select(SELECT).eq("owner_id", ownerId).eq("id", queueId).maybeSingle();
  if (error) return { ok: false, reason: isSchemaUnavailable(error) ? "schema_unavailable" : "not_found" };
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending" && row.status !== "confirmed") return { ok: false, reason: "not_found" };
  const snapshot = asRow(row.source_snapshot);
  const source = String(row.source);
  const candidate: QualificationCandidate = {
    source,
    externalListingId: String(row.external_listing_id),
    originalUrl: String(row.original_url),
    normalizedUrl: String(row.normalized_url ?? row.original_url),
    title: nullableString(row.title),
    description: nullableString(snapshot.description),
    price: decision.price,
    area: decision.area,
    pricePerSqm: decision.price / decision.area,
    rooms: decision.rooms,
    city: decision.city,
    district: decision.district,
    buildingType: decision.buildingType,
    marketType: decision.marketType,
    propertyType: "apartment",
    rawPayload: {
      ...asRow(snapshot.rawPayload),
      detailVerified: true,
      detailContradictions: [],
      operatorVerification: decision,
    },
    contentHash: String(snapshot.contentHash ?? `${source}:${row.external_listing_id}`),
  };
  const outcome = qualifyRadarCandidate(candidate, 2, decision, minPricePerSqm, selectedDistricts);
  if (!outcome.qualified) return { ok: false, reason: "no_longer_qualifies", detail: outcome.reason };
  const { data, error: saveError } = await supabase.rpc("resolve_price_radar_verification_candidate", {
    p_owner_id: ownerId,
    p_queue_id: queueId,
    p_operator_id: ownerId,
    p_decision: { ...decision, confirmedAt: new Date().toISOString() },
  });
  if (saveError) return { ok: false, reason: isSchemaUnavailable(saveError) ? "schema_unavailable" : "invalid_decision" };
  return typeof data === "string" ? { ok: true, listingId: data } : { ok: false, reason: "not_found" };
}

export async function setRadarVerificationQueueRejection(ownerId: string, queueId: string, rejected: boolean, supabase: SupabaseClient = createAdminClient()): Promise<{ ok: boolean; reason?: "schema_unavailable" | "not_found" }> {
  const { data, error } = await supabase.rpc("set_price_radar_verification_queue_rejection", { p_owner_id: ownerId, p_queue_id: queueId, p_rejected: rejected });
  if (error) return { ok: false, reason: isSchemaUnavailable(error) ? "schema_unavailable" : "not_found" };
  return data === true ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function confirmedRadarVerificationDecisions(
  supabase: SupabaseClient,
  ownerId: string,
  source: string,
  externalIds: readonly string[],
): Promise<Map<string, RadarVerificationDecision>> {
  if (!externalIds.length) return new Map();
  const { data, error } = await supabase.from("price_radar_verification_queue")
    .select("external_listing_id,operator_decision").eq("owner_id", ownerId).eq("source", source).eq("status", "confirmed")
    .in("external_listing_id", [...new Set(externalIds)]);
  if (error) {
    if (isSchemaUnavailable(error)) return new Map();
    throw new Error("Nie udało się odczytać zapisanej decyzji weryfikacyjnej Radaru.");
  }
  const decisions = new Map<string, RadarVerificationDecision>();
  for (const row of Array.isArray(data) ? data as Row[] : []) {
    if (typeof row.external_listing_id === "string" && isVerificationDecision(row.operator_decision)) decisions.set(row.external_listing_id, row.operator_decision);
  }
  return decisions;
}

export function applyRadarVerificationDecision(listing: PropertySourceListing, decision: RadarVerificationDecision): PropertySourceListing {
  return {
    ...listing,
    price: decision.price,
    area: decision.area,
    pricePerSqm: decision.price / decision.area,
    rooms: decision.rooms,
    city: decision.city,
    district: decision.district,
    buildingType: decision.buildingType,
    rawPayload: {
      ...listing.rawPayload,
      // The operator has now confirmed the actual total asking price. Keep
      // the original parser signals for audit, but stop a previous `from` or
      // per-m² interpretation from vetoing that explicit decision.
      operatorPriceEvidence: {
        priceIsStartingAt: listing.rawPayload.priceIsStartingAt === true,
        priceKind: typeof listing.rawPayload.priceKind === "string" ? listing.rawPayload.priceKind : null,
        priceUnit: typeof listing.rawPayload.priceUnit === "string" ? listing.rawPayload.priceUnit : null,
      },
      priceIsStartingAt: false,
      priceKind: "total",
      priceUnit: "total",
      marketType: decision.marketType,
      propertyType: "apartment",
      detailVerified: true,
      detailContradictions: [],
      operatorVerification: decision,
    },
  };
}

function toQualificationCandidate(listing: PropertySourceListing, district: string | null): QualificationCandidate {
  return {
    source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
    title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
    rooms: listing.rooms, city: listing.city, district, buildingType: listing.buildingType,
    marketType: typeof listing.rawPayload.marketType === "string" ? listing.rawPayload.marketType : null,
    propertyType: typeof listing.rawPayload.propertyType === "string" ? listing.rawPayload.propertyType : null,
    rawPayload: listing.rawPayload, contentHash: listing.contentHash,
  };
}

function toQueueItem(row: Row): RadarVerificationQueueItem | null {
  const snapshot = asRow(row.source_snapshot);
  const id = nullableString(row.id); const source = nullableString(row.source); const externalListingId = nullableString(row.external_listing_id);
  const originalUrl = nullableString(row.original_url); const firstSeenAt = nullableString(row.first_seen_at); const lastSeenAt = nullableString(row.last_seen_at);
  const status = row.status === "pending" || row.status === "confirmed" || row.status === "rejected" ? row.status : null;
  if (!id || !source || !externalListingId || !originalUrl || !firstSeenAt || !lastSeenAt || !status) return null;
  const decision = isVerificationDecision(row.operator_decision) ? row.operator_decision : null;
  const fieldEvidence = asRow(row.field_evidence) as Record<string, string>;
  return {
    id, source: source as RadarSource, externalListingId, originalUrl, title: nullableString(row.title), status,
    firstSeenAt, lastSeenAt,
    snapshot: {
      description: nullableString(snapshot.description), price: nullableNumber(snapshot.price), pricePerSqm: nullableNumber(snapshot.pricePerSqm),
      area: nullableNumber(snapshot.area), rooms: nullableNumber(snapshot.rooms), city: nullableString(snapshot.city), district: nullableString(snapshot.district),
      buildingType: nullableString(snapshot.buildingType), marketType: nullableString(snapshot.marketType),
      qualityCategory: snapshot.qualityCategory === "fresh_renovation" || snapshot.qualityCategory === "ready_high_standard" ? snapshot.qualityCategory : null,
      publishedAt: nullableString(snapshot.publishedAt), sourceUpdatedAt: nullableString(snapshot.sourceUpdatedAt), collectedAt: nullableString(snapshot.collectedAt),
      sourceHttpStatus: nullableNumber(snapshot.sourceHttpStatus), finalUrl: nullableString(snapshot.finalUrl), sourceIdentity: nullableString(snapshot.sourceIdentity),
      confirmedFields: stringArray(row.confirmed_fields), missingFields: stringArray(row.missing_fields), contradictoryFields: stringArray(row.contradictory_fields),
      fieldEvidence, routingReasons: stringArray(row.routing_reasons), suggestedDistrict: nullableString(row.suggested_district), suggestionEvidence: nullableString(row.suggestion_evidence),
    },
    decision, decisionAt: nullableString(row.decision_at), rejectedAt: nullableString(row.rejected_at),
  };
}

function isVerificationDecision(value: unknown): value is RadarVerificationDecision {
  if (!isRecord(value)) return false;
  return value.apartmentSaleConfirmed === true && typeof value.price === "number" && value.price > 0
    && typeof value.area === "number" && value.area > 0 && typeof value.rooms === "number" && Number.isInteger(value.rooms) && value.rooms > 0
    && value.city === "Łódź" && DEFAULT_RADAR_DISTRICTS.includes(value.district as (typeof DEFAULT_RADAR_DISTRICTS)[number])
    && isBuildingType(value.buildingType) && (value.marketType === "primary" || value.marketType === "secondary")
    && (value.qualityCategory === "fresh_renovation" || value.qualityCategory === "ready_high_standard");
}

function isBuildingType(value: unknown): value is "blok" | "apartamentowiec" { return value === "blok" || value === "apartamentowiec"; }
function isSchemaUnavailable(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  if (["42P01", "PGRST205", "42883", "PGRST202"].includes(code)) return true;
  return /price_radar_verification_queue|price_radar_verification_candidate/iu.test(String(error.message ?? "")) && /does not exist|not find|schema cache/iu.test(String(error.message ?? ""));
}

function sanitizeSourceText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.replace(/<[^>]*>/gu, " ").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[kontakt pominięty]")
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/gu, "[telefon pominięty]")
    .replace(/https?:\/\/\S+/giu, "[link pominięty]").replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : null;
}

const EVIDENCE_PATTERNS: Record<string, RegExp> = {
  total_price: /(?:\d[\d .\u00a0]*\s*(?:zł|pln))/iu,
  area: /\d+(?:[,.]\d+)?\s*(?:m²|m2|mkw)/iu,
  rooms: /\d+\s*(?:pokoi|pokoje|pok\.)/iu,
  city_lodz: /Łódź/iu,
  district: /Bałuty|Górna|Polesie|Śródmieście|Widzew/iu,
  building_type: /blok|apartamentowiec|kamienica/iu,
  market_type: /rynek (?:pierwotny|wtórny)|od dewelopera/iu,
  standard: /świeżo po remoncie|generaln\w* remont|pod klucz|wysoki standard|gotowe do zamieszkania/iu,
  apartment_sale: /mieszkanie.{0,60}(?:sprzedaż|sprzedam)|sprzedam.{0,60}mieszkanie/iu,
};
function findQuote(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 45); const end = Math.min(text.length, match.index + match[0].length + 75);
    return sanitizeSourceText(text.slice(start, end), 180);
  }
  return null;
}
function positive(value: number | null): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }
function validDate(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 32) : []; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function asRow(value: unknown): Row { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function isRecord(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
