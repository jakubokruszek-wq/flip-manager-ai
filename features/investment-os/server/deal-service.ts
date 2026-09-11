import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { calculateResaleArv, selectResaleComps } from "@/features/market-intelligence/resale-arv";
import type { ResaleCompRecord } from "@/features/market-intelligence/resale-comps";
import { DEFAULT_UNDERWRITING_SETTINGS, type UnderwritingSettings } from "@/features/flip-finder/underwriting";
import { buildCanonicalDeal, downstreamForChange, fingerprint, fingerprintsEqual } from "../engine";
import { DEFAULT_INVESTMENT_DECISION_POLICY, type InvestmentDecisionPolicy } from "../types";
import type { CanonicalDeal, DealFactOverrides, DealListingInput, DirectorTrackRecord, EvidenceItem, MarketEvidence } from "../types";

type Row = Record<string, unknown>;
type InvestmentSettings = UnderwritingSettings & { decisionPolicy: InvestmentDecisionPolicy };

export async function getInvestmentDeal(listingId: string): Promise<CanonicalDeal | null> {
  const db = createAdminClient();
  const { data: listing, error } = await db.from("listings").select("id,source,original_url,external_listing_id,lifecycle_status,manual_decision,city,district,address,area,rooms,floor,building_type,ownership,description,rent,price,price_per_sqm,gallery_status,images,last_seen_at,updated_at").eq("id", listingId).maybeSingle();
  if (error) throw error;
  if (!listing) return null;
  const existing = await db.from("deals").select("*").eq("listing_id", listingId).maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") throw existing.error;
  const dealId = text(existing.data?.id) ?? crypto.randomUUID();
  const overridesResult = existing.data ? await db.from("deal_fact_overrides").select("values").eq("deal_id", dealId).maybeSingle() : { data: null, error: null };
  if (overridesResult.error) throw overridesResult.error;
  const settings = await loadSettings(db);
  const { data: latestSnapshot, error: snapshotError } = await db.from("listing_snapshots").select("id,captured_at,price,raw_data").eq("listing_id", listingId).order("captured_at", { ascending: false }).limit(1).maybeSingle();
  if (snapshotError) throw snapshotError;
  const listingInput = toListingInput(listing as Row, latestSnapshot as Row | null);
  const market = await resolveMarketEvidence(db, listingInput);
  const trackRecords = await loadDirectorTrackRecords(db);
  const now = new Date().toISOString();
  const deal = buildCanonicalDeal({ dealId, listing: listingInput, overrides: object(overridesResult.data?.values) as DealFactOverrides, market, settings, policy: settings.decisionPolicy, now, createdAt: text(existing.data?.created_at) ?? undefined, directorTrackRecords: trackRecords });
  const old = existing.data ? toCanonicalDeal(existing.data as Row) : null;
  const settled = old && [old.scout, old.verify, old.market, old.underwriting, old.ceo].every((director) => director.status === "COMPLETE" || director.status === "BLOCKED");
  if (old && settled && fingerprintsEqual(old, deal)) { await persistIntelligence(db, old); return old; }
  if (!old || !fingerprintsEqual(old, deal) || !settled) {
    const { error: writeError } = await db.from("deals").upsert(toDealRow(deal), { onConflict: "listing_id" });
    if (writeError) throw writeError;
  }
  await persistIntelligence(db, deal);
  return deal;
}

export async function saveDealOverrides(listingId: string, values: DealFactOverrides): Promise<{ deal: CanonicalDeal; invalidated: string[] }> {
  const current = await getInvestmentDeal(listingId);
  if (!current) throw new Error("DEAL_LISTING_NOT_FOUND");
  const clean = sanitizeOverrides(values);
  const db = createAdminClient();
  const { data: previousRow, error: previousError } = await db.from("deal_fact_overrides").select("values").eq("deal_id", current.id).maybeSingle();
  if (previousError) throw previousError;
  const previous = object(previousRow?.values); const cleanRow = object(clean); const changed = [...new Set([...Object.keys(previous), ...Object.keys(cleanRow)].filter((key) => previous[key] !== cleanRow[key]))];
  const factChanges = changed.filter((key) => key in current.facts) as Array<keyof CanonicalDeal["facts"]>;
  const invalidated = new Set<string>(factChanges.length ? downstreamForChange(factChanges) : []);
  if (changed.includes("resalePerM2")) ["MARKET", "UNDERWRITER", "CEO"].forEach((name) => invalidated.add(name));
  if (changed.some((key) => ["renovationPerM2", "holdingMonths", "additionalCosts"].includes(key))) ["UNDERWRITER", "CEO"].forEach((name) => invalidated.add(name));
  const events = factChanges.map((field) => {
    const fact = current.facts[field];
    const overrideValue = Object.prototype.hasOwnProperty.call(cleanRow, field) ? cleanRow[field] : null;
    return { field, overrideValue, sourceEvidenceIds: fact.sourceEvidenceIds, conflictStatus: fact.sourceValue !== null && overrideValue !== null && !Object.is(fact.sourceValue, overrideValue) ? "CRITICAL" : "NONE", contentHash: fingerprint({ dealId: current.id, field, overrideValue, sourceEvidenceIds: fact.sourceEvidenceIds }) };
  });
  const { error } = await db.rpc("apply_investment_override", { p_deal_id: current.id, p_values: clean, p_invalidated: [...invalidated], p_events: events, p_user_id: "application" });
  if (error) throw error;
  const deal = await getInvestmentDeal(listingId);
  if (!deal) throw new Error("DEAL_RECOMPUTE_FAILED");
  return { deal, invalidated: [...invalidated] };
}

export async function loadInvestmentSettings(): Promise<UnderwritingSettings> { return loadSettings(createAdminClient()); }

export async function saveInvestmentSettings(value: unknown): Promise<UnderwritingSettings> {
  const settings = validateSettings(value);
  const db = createAdminClient();
  const { data: current } = await db.from("underwriting_settings").select("version").eq("id", "default").maybeSingle();
  const { error } = await db.from("underwriting_settings").upsert({ id: "default", version: number(current?.version) + 1, values: settings }, { onConflict: "id" });
  if (error) throw error;
  const { data: deals, error: dealsError } = await db.from("deals").select("id,underwriting,ceo");
  if (dealsError) throw dealsError;
  for (const row of deals ?? []) {
    await db.from("deals").update({ underwriting: { ...object(row.underwriting), status: "STALE" }, ceo: { ...object(row.ceo), status: "STALE" } }).eq("id", row.id);
  }
  return settings;
}

export async function listMarketAssumptions(): Promise<Row[]> {
  const { data, error } = await createAdminClient().from("market_assumptions").select("*").eq("active", true).order("effective_from", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Row[];
}

export async function saveMarketAssumption(value: unknown): Promise<Row> {
  const input = validateAssumption(value); const db = createAdminClient();
  const { data, error } = await db.from("market_assumptions").insert(input).select("*").single();
  if (error) throw error;
  const query = db.from("deals").select("id,facts,market,underwriting,ceo");
  const { data: deals, error: dealsError } = await query;
  if (dealsError) throw dealsError;
  for (const deal of deals ?? []) {
    const facts = object(deal.facts); const city = effectiveText(facts.city); const district = effectiveText(facts.district);
    const assumptionCity = text(input.city); const assumptionDistrict = text(input.district);
    if (!same(city, assumptionCity) || (assumptionDistrict && !same(district, assumptionDistrict))) continue;
    await db.from("deals").update({ market: { ...object(deal.market), status: "STALE" }, underwriting: { ...object(deal.underwriting), status: "STALE" }, ceo: { ...object(deal.ceo), status: "STALE" } }).eq("id", deal.id);
  }
  return data as Row;
}

async function loadSettings(db: ReturnType<typeof createAdminClient>): Promise<InvestmentSettings> {
  const { data, error } = await db.from("underwriting_settings").select("values").eq("id", "default").maybeSingle();
  if (error) throw error;
  return validateSettings(data?.values ?? DEFAULT_UNDERWRITING_SETTINGS);
}

async function loadDirectorTrackRecords(db: ReturnType<typeof createAdminClient>): Promise<DirectorTrackRecord[]> {
  const { data, error } = await db.from("director_scorecards").select("director,deal_count,median_error_percent,p90_error_percent,confidence_calibration,critical_misses,computed_at");
  if (error) throw error;
  return (data ?? []).flatMap((row) => { const director = text(row.director); if (!director || !["SCOUT","VERIFY","MARKET","UNDERWRITER","CEO","RISK","LEGAL"].includes(director)) return []; return [{ director: director as DirectorTrackRecord["director"], dealCount: number(row.deal_count), medianErrorPercent: nullableNumber(row.median_error_percent), p90ErrorPercent: nullableNumber(row.p90_error_percent), confidenceCalibration: text(row.confidence_calibration), criticalMisses: number(row.critical_misses), computedAt: text(row.computed_at) }]; });
}

async function resolveMarketEvidence(db: ReturnType<typeof createAdminClient>, listing: DealListingInput): Promise<MarketEvidence | null> {
  const { data: rows, error } = await db.from("resale_comps").select("*").eq("active", true).limit(500);
  if (error && error.code !== "42P01") throw error;
  const comps = (rows ?? []).map(toComp).filter((item): item is ResaleCompRecord => item !== null);
  const selected = selectResaleComps({ id: listing.id, area: listing.areaM2, rooms: listing.rooms, city: listing.city, district: listing.district, address: listing.street, buildingType: listing.buildingType, floor: listing.floor }, comps);
  const arv = calculateResaleArv({ area: listing.areaM2 }, selected);
  if (arv.conservativePrice && arv.expectedPrice && arv.optimisticPrice && listing.areaM2) {
    const observedAt = selected.map((item) => item.lastSeenAt).sort().at(-1) ?? null;
    return { id: null, matchedBy: "RESALE_COMPS", low: arv.conservativePrice / listing.areaM2, base: arv.expectedPrice / listing.areaM2, high: arv.optimisticPrice / listing.areaM2, confidence: Math.min(90, 45 + selected.length * 5), provenance: "DERIVED", compCount: selected.length, fallbackLevel: 0, fallbackReason: "DIRECT_COMPARABLE_SET", confidencePenalty: 0, observedAt, evidenceId: selected.length ? `resale-comps:${selected.map((item) => item.id).sort().join(",")}` : null, priceEvidenceType: "ASKING", comparables: selected.map((item) => ({ id: item.id, source: item.source, sourceUrl: item.originalUrl, pricePerM2: item.pricePerSqm!, similarityScore: item.similarityScore, dataQuality: comparableDataQuality(item), freshnessDays: item.freshnessDays ?? null, distanceMeters: item.distanceMeters ?? null, adjustments: item.matchReasons, weight: comparableWeight(item.similarityScore, item.freshnessDays ?? null, item.renovationConfidence ?? "LOW"), outlierReason: item.outlierReason ?? null, priceEvidenceType: "ASKING" as const })) };
  }
  const { data: assumptions, error: assumptionError } = await db.from("market_assumptions").select("*").eq("active", true).eq("city", listing.city ?? "").order("effective_from", { ascending: false });
  if (assumptionError) throw assumptionError;
  const matched = (assumptions ?? []).map((row) => ({ row: row as Row, score: assumptionScore(row as Row, listing) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score)[0]?.row;
  if (!matched) return null;
  const specificity = assumptionScore(matched, listing);
  const fallbackLevel = specificity >= 15 ? 1 : specificity >= 9 ? 2 : specificity >= 5 ? 3 : 4;
  const confidencePenalty = fallbackLevel * 5;
  return { id: text(matched.id), matchedBy: assumptionMatchLabel(matched), low: number(matched.resale_price_per_m2_low), base: number(matched.resale_price_per_m2_base), high: number(matched.resale_price_per_m2_high), confidence: number(matched.confidence), provenance: matched.provenance === "MARKET_ASSUMPTION" ? "MARKET_ASSUMPTION" : "USER_ASSUMPTION", compCount: 0, fallbackLevel, fallbackReason: fallbackLevel === 1 ? "SPECIFIC_MARKET_ASSUMPTION" : fallbackLevel === 2 ? "DISTRICT_MARKET_FALLBACK" : fallbackLevel === 3 ? "PROPERTY_PROFILE_FALLBACK" : "CITY_ONLY_FALLBACK", confidencePenalty, observedAt: text(matched.effective_from) ?? text(matched.updated_at) ?? null, evidenceId: text(matched.id), priceEvidenceType: "USER_ASSUMPTION", comparables: [] };
}

function toListingInput(row: Row, snapshot: Row | null): DealListingInput {
  const lifecycle = text(row.lifecycle_status); const manual = row.manual_decision === "ACCEPTED" || row.manual_decision === "REJECTED" ? row.manual_decision : null;
  const externalListingId = text(row.external_listing_id); const sourceUrl = text(row.original_url)!; const source = text(row.source)!;
  const observedAt = text(row.last_seen_at) ?? text(row.updated_at);
  return { id: text(row.id)!, source, sourceUrl, externalListingId, lifecycleStatus: lifecycle, decisionBucket: lifecycle === "REJECTED" ? "REJECTED" : lifecycle === "REVIEW" ? "REVIEW" : "MATCHED", manualDecision: manual, city: text(row.city), district: text(row.district), street: text(row.address), areaM2: nullableNumber(row.area), rooms: nullableNumber(row.rooms), floor: text(row.floor), floorsTotal: null, buildingType: text(row.building_type), yearBuilt: null, ownership: text(row.ownership), condition: text(row.description), monthlyFee: nullableNumber(row.rent), askingPrice: nullableNumber(row.price), askingPricePerM2: nullableNumber(row.price_per_sqm), galleryStatus: text(row.gallery_status), imageCount: Array.isArray(row.images) ? row.images.length : 0, identityExact: source !== "facebook" || exactFacebookUrl(sourceUrl, externalListingId), observedAt, conflicts: detectSnapshotConflicts(row, snapshot, observedAt) };
}

function detectSnapshotConflicts(listing: Row, snapshot: Row | null, observedAt: string | null): DealListingInput["conflicts"] {
  if (!snapshot || !observedAt || !text(snapshot.captured_at) || Math.abs(Date.parse(observedAt) - Date.parse(text(snapshot.captured_at)!)) > 600_000) return [];
  const raw = object(snapshot.raw_data); const id = text(snapshot.id) ?? "latest";
  const candidates: Array<{ field: "askingPrice" | "areaM2" | "rooms"; listingValue: number | null; rawValue: number | null }> = [
    { field: "askingPrice", listingValue: nullableNumber(listing.price), rawValue: firstNumber(raw, ["price", "askingPrice", "asking_price"]) },
    { field: "areaM2", listingValue: nullableNumber(listing.area), rawValue: firstNumber(raw, ["area", "areaM2", "area_m2"]) },
    { field: "rooms", listingValue: nullableNumber(listing.rooms), rawValue: firstNumber(raw, ["rooms", "roomCount", "room_count"]) },
  ];
  return candidates.filter((item) => item.listingValue !== null && item.rawValue !== null && Math.abs(item.listingValue - item.rawValue) > 0.01).map((item) => ({ field: item.field, values: [{ value: item.listingValue!, source: "LISTING", observedAt, evidenceId: `listing:${text(listing.id)}:${item.field}` }, { value: item.rawValue!, source: "LATEST_SNAPSHOT_RAW", observedAt: text(snapshot.captured_at), evidenceId: `snapshot:${id}:${item.field}` }] }));
}

function toComp(row: Row): ResaleCompRecord | null {
  const id = text(row.id), source = text(row.source), externalListingId = text(row.external_listing_id), lastSeenAt = text(row.last_seen_at);
  if (!id || !externalListingId || !lastSeenAt || !["facebook", "otodom", "olx", "morizon"].includes(source ?? "")) return null;
  const renovationStatus = ["RENOVATED", "MOVE_IN_READY", "REFRESHED", "UNKNOWN"].includes(text(row.renovation_status) ?? "") ? text(row.renovation_status)! as ResaleCompRecord["classification"]["renovationStatus"] : "UNKNOWN";
  const renovationConfidence = ["HIGH", "MEDIUM", "LOW"].includes(text(row.renovation_confidence) ?? "") ? text(row.renovation_confidence)! as ResaleCompRecord["classification"]["renovationConfidence"] : "LOW";
  return { id, source: source as ResaleCompRecord["source"], externalListingId, canonicalUrl: text(row.canonical_url), title: text(row.title), description: text(row.description), city: text(row.city), district: text(row.district), street: text(row.street), address: text(row.address), latitude: nullableNumber(row.latitude), longitude: nullableNumber(row.longitude), price: nullableNumber(row.price), areaM2: nullableNumber(row.area_m2), pricePerM2: nullableNumber(row.price_per_m2), rooms: nullableNumber(row.rooms), floor: text(row.floor), floors: text(row.floors), buildingType: text(row.building_type), constructionYear: nullableNumber(row.construction_year), ownership: text(row.ownership), balcony: bool(row.balcony), elevator: bool(row.elevator), parking: bool(row.parking), listingCreatedAt: text(row.listing_created_at), firstSeenAt: text(row.first_seen_at) ?? lastSeenAt, lastSeenAt, active: row.active === true, sellerType: text(row.seller_type), fingerprint: text(row.fingerprint), classification: { isCandidate: true, renovationStatus, renovationConfidence, finishLevel: text(row.finish_level), evidence: [], outlierReason: text(row.outlier_reason), exclusionReason: null } };
}

function toDealRow(deal: CanonicalDeal): Row { return { id: deal.id, listing_id: deal.listingId, stage: deal.stage, facts_fingerprint: deal.factsFingerprint, facts: deal.facts, scout: deal.scout, verify: deal.verify, market: deal.market, underwriting: deal.underwriting, ceo: deal.ceo, playbook: deal.playbook, evidence_fabric: deal.evidenceFabric, information_requests: deal.informationRequests, analysis_level: deal.analysisLevel, created_at: deal.createdAt, updated_at: deal.updatedAt }; }
function toCanonicalDeal(row: Row): CanonicalDeal { return { id: text(row.id)!, listingId: text(row.listing_id)!, stage: text(row.stage)! as CanonicalDeal["stage"], factsFingerprint: text(row.facts_fingerprint)!, facts: object(row.facts) as CanonicalDeal["facts"], scout: object(row.scout) as CanonicalDeal["scout"], verify: object(row.verify) as CanonicalDeal["verify"], market: object(row.market) as CanonicalDeal["market"], underwriting: object(row.underwriting) as CanonicalDeal["underwriting"], ceo: object(row.ceo) as CanonicalDeal["ceo"], playbook: object(row.playbook) as CanonicalDeal["playbook"], evidenceFabric: Array.isArray(row.evidence_fabric) ? row.evidence_fabric as CanonicalDeal["evidenceFabric"] : [], informationRequests: Array.isArray(row.information_requests) ? row.information_requests as CanonicalDeal["informationRequests"] : [], analysisLevel: [0, 1, 2, 3].includes(number(row.analysis_level)) ? number(row.analysis_level) as CanonicalDeal["analysisLevel"] : 1, createdAt: text(row.created_at)!, updatedAt: text(row.updated_at)! }; }

async function persistIntelligence(db: ReturnType<typeof createAdminClient>, deal: CanonicalDeal): Promise<void> {
  if (deal.evidenceFabric.length) {
    const evidenceRows = deal.evidenceFabric.map((item) => ({ id: item.id, deal_id: item.dealId, type: item.type, evidence_type: item.evidenceType ?? evidenceTypeFor(item), field: item.field ?? null, source_type: item.sourceType, source_name: item.sourceName.slice(0, 160), structured_payload: item.value, source_url: item.sourceUrl, document_id: item.documentId, observed_at: item.observedAt, valid_from: item.validFrom, valid_until: item.validUntil, reliability: item.reliability, confidence: item.confidence, director_who_requested: item.directorWhoRequested, verification_status: item.verificationStatus, conflicts_with: item.conflictsWith, supersedes_evidence_id: item.supersedesEvidenceId ?? null, content_hash: item.contentHash ?? fingerprint({ id: item.id, field: item.field ?? null, value: item.value }) }));
    const { error } = await db.from("deal_evidence").upsert(evidenceRows, { onConflict: "id", ignoreDuplicates: true }); if (error) throw error;
  }
  const observationRows = Object.entries(deal.facts).filter(([, fact]) => fact.effectiveValue !== null).map(([field, fact]) => ({ listing_id: deal.listingId, deal_id: deal.id, field, value: fact.effectiveValue, evidence_id: fact.evidenceId, provenance: fact.provenance, observed_at: fact.observedAt, valid_from: fact.observedAt, valid_until: null, content_hash: fingerprint({ dealId: deal.id, field, value: fact.effectiveValue, evidenceId: fact.evidenceId }) }));
  if (observationRows.length) { const { error } = await db.from("listing_fact_observations").upsert(observationRows, { onConflict: "listing_id,field,content_hash", ignoreDuplicates: true }); if (error) throw error; }
  const directors = [deal.scout, deal.verify, deal.market, deal.underwriting, deal.ceo];
  const runRows = directors.map((output) => ({ id: crypto.randomUUID(), deal_id: deal.id, director: output.director, input_fingerprint: output.inputFingerprint, output_version: output.version, director_version: output.version, attempt: 1, status: output.status, queued_at: output.computedAt, started_at: output.computedAt, finished_at: output.computedAt, failure_reason: output.status === "FAILED" ? output.reasonCodes[0] ?? "DIRECTOR_FAILED" : null, stale_reason: output.status === "STALE" ? "INPUT_CHANGED" : null, tools_requested: output.execution.toolsRequested, tools_succeeded: output.execution.toolsSucceeded, tools_failed: output.execution.toolsFailed, evidence_count: output.execution.evidenceCount, conflict_count: output.execution.conflictCount, output, confidence: output.confidence, elapsed_ms: output.execution.elapsedMs, computed_at: output.computedAt }));
  const { error: runError } = await db.from("director_runs").upsert(runRows, { onConflict: "deal_id,director,input_fingerprint,output_version", ignoreDuplicates: true }); if (runError) throw runError;
  const { data: persistedRuns, error: persistedRunError } = await db.from("director_runs").select("id,director,input_fingerprint,output_version").eq("deal_id", deal.id);
  if (persistedRunError) throw persistedRunError;
  const runIdFor = (output: { director: string; inputFingerprint: string; version: number }): string | null => text((persistedRuns ?? []).find((row) => row.director === output.director && row.input_fingerprint === output.inputFingerprint && number(row.output_version) === output.version)?.id);
  const foundationOutputs = [deal.verify, deal.market, deal.underwriting].map((output) => { const runId = runIdFor(output); return runId ? { id: crypto.randomUUID(), run_id: runId, deal_id: deal.id, director: output.director, director_version: output.version, input_fingerprint: output.inputFingerprint, result: output.result, confidence_data: output.confidenceAxes.data, confidence_method: output.confidenceAxes.method, confidence_market: output.confidenceAxes.market, evidence_ids: output.provenance.flatMap((item) => item.evidenceId ? [item.evidenceId] : []), missing_fields: output.missingFields, conflicts: output.reasonCodes.filter((reason) => reason.includes("CONFLICT")), warnings: output.warnings, recommendation: output.recommendation, reason_codes: output.reasonCodes, next_best_actions: output.nextBestActions, decision_triggers: output.decisionTriggers, what_would_change_my_mind: output.whatWouldChangeMyMind, computed_at: output.computedAt } : null; }).filter((row): row is NonNullable<typeof row> => row !== null);
  if (foundationOutputs.length) { const { error } = await db.from("director_outputs").upsert(foundationOutputs, { onConflict: "deal_id,director,director_version,input_fingerprint", ignoreDuplicates: true }); if (error) throw error; }
  const { data: persistedOutputs, error: persistedOutputsError } = await db.from("director_outputs").select("id,director,input_fingerprint").eq("deal_id", deal.id);
  if (persistedOutputsError) throw persistedOutputsError;
  const ceo = deal.ceo.result;
  if (ceo) {
    const sourceDirectorOutputIds = (persistedOutputs ?? []).filter((row) => ["VERIFY", "MARKET", "UNDERWRITER"].includes(String(row.director))).map((row) => String(row.id));
    const { error } = await db.from("ceo_decisions").upsert({ id: crypto.randomUUID(), deal_id: deal.id, decision_version: deal.ceo.version, input_fingerprint: deal.ceo.inputFingerprint, internal_state: ceo.decision, user_facing_action: ceoAction(ceo.action), gate_results: ceo.criticalGates, dissent: ceo.dissent, conditions_to_proceed: ceo.conditionsToProceed, walk_away_conditions: ceo.walkAwayConditions, missing_critical_information: ceo.missingBeforePurchase, reason_codes: deal.ceo.reasonCodes, source_director_output_ids: sourceDirectorOutputIds, created_at: deal.ceo.computedAt }, { onConflict: "deal_id,decision_version,input_fingerprint", ignoreDuplicates: true });
    if (error) throw error;
  }
  const conflictRows = deal.evidenceFabric.flatMap((item) => item.conflictsWith.map((other) => { const [left_evidence_id, right_evidence_id] = [item.id, other].sort(); return { deal_id: deal.id, field: item.field ?? "unknown", left_evidence_id, right_evidence_id, status: "OPEN" }; }));
  if (conflictRows.length) { const { error } = await db.from("evidence_conflicts").upsert(conflictRows, { onConflict: "deal_id,field,left_evidence_id,right_evidence_id", ignoreDuplicates: true }); if (error) throw error; }
  if (deal.informationRequests.length) { const requestRows = deal.informationRequests.map((item) => ({ id: item.id, deal_id: deal.id, field: item.field, question: item.question, priority: item.priority, value_of_information: item.valueOfInformation, decision_impact: item.decisionImpact, requested_by: item.requestedBy, evidence_needed: item.evidenceNeeded, status: item.status })); const { error } = await db.from("director_information_requests").upsert(requestRows, { onConflict: "id" }); if (error) throw error; }
}
function evidenceTypeFor(item: EvidenceItem): EvidenceItem["evidenceType"] { if (item.type === "PREDICTION") return "AI_EXTRACTION"; if (item.sourceType === "USER_PROVIDED") return "MANUAL_INPUT"; if (item.sourceType === "MULTIPLE_INDEPENDENT_SOURCES") return "MARKET_COMPARABLE"; return "LISTING_OBSERVATION"; }
function ceoAction(action: string): "JEDZ_OBEJRZEC" | "NEGOCJUJ" | "KUP" | "HOLD" | "ODRZUC" { if (action === "KUP") return "KUP"; if (action === "NEGOCJUJ") return "NEGOCJUJ"; if (action === "ODRZUÄ†") return "ODRZUC"; if (action.startsWith("JED")) return "JEDZ_OBEJRZEC"; return "HOLD"; }
function sanitizeOverrides(value: DealFactOverrides): DealFactOverrides { const allowed = new Set(["city","district","street","areaM2","rooms","floor","floorsTotal","buildingType","yearBuilt","ownership","condition","monthlyFee","askingPrice","resalePerM2","renovationPerM2","holdingMonths","additionalCosts"]); return Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.has(key) && (item === null || typeof item === "string" || typeof item === "number") && !(typeof item === "number" && (!Number.isFinite(item) || item < 0)))); }
function validateSettings(value: unknown): InvestmentSettings { const v = object(value); const renovation = object(v.renovationPerM2), market = object(v.marketResalePerM2), policy = object(v.decisionPolicy); const critical = Array.isArray(policy.criticalBuyFacts) ? policy.criticalBuyFacts.filter((item): item is InvestmentDecisionPolicy["criticalBuyFacts"][number] => typeof item === "string" && DEFAULT_INVESTMENT_DECISION_POLICY.criticalBuyFacts.includes(item as InvestmentDecisionPolicy["criticalBuyFacts"][number])) : DEFAULT_INVESTMENT_DECISION_POLICY.criticalBuyFacts; const decisionPolicy: InvestmentDecisionPolicy = { criticalBuyFacts: critical.length ? [...new Set(critical)] : DEFAULT_INVESTMENT_DECISION_POLICY.criticalBuyFacts, minimumBuyConfidence: bounded(policy.minimumBuyConfidence, DEFAULT_INVESTMENT_DECISION_POLICY.minimumBuyConfidence, 0, 100), maximumMarketFallbackLevel: bounded(policy.maximumMarketFallbackLevel, DEFAULT_INVESTMENT_DECISION_POLICY.maximumMarketFallbackLevel, 0, 4), maximumMarketAgeDays: bounded(policy.maximumMarketAgeDays, DEFAULT_INVESTMENT_DECISION_POLICY.maximumMarketAgeDays, 1, 365), minimumMarketComparableCount: bounded(policy.minimumMarketComparableCount, DEFAULT_INVESTMENT_DECISION_POLICY.minimumMarketComparableCount, 2, 10), deepDiveValueThresholdPLN: bounded(policy.deepDiveValueThresholdPLN, DEFAULT_INVESTMENT_DECISION_POLICY.deepDiveValueThresholdPLN, 1, 100_000_000) }; const result: InvestmentSettings = { ...DEFAULT_UNDERWRITING_SETTINGS, ...v, renovationPerM2: { LIGHT: nonnegative(renovation.LIGHT), STANDARD: nonnegative(renovation.STANDARD), FULL: nonnegative(renovation.FULL) }, marketResalePerM2: { low: nonnegative(market.low), base: nonnegative(market.base), high: nonnegative(market.high) }, marketResaleProvenance: "USER_ASSUMPTION", decisionPolicy } as InvestmentSettings; for (const key of ["contingencyPercent","purchaseTaxPercent","purchaseCommissionPercent","salesCostPercent","financingAnnualRatePercent","financingLoanPercent","minimumMarginPercent","minimumROI","targetNegotiationBufferPercent"] as const) if (result[key] < 0 || result[key] > 100) throw new Error(`INVALID_SETTING_${key}`); return result; }
function validateAssumption(value: unknown): Row { const v = object(value); const city = text(v.city); const low = positive(v.low), base = positive(v.base), high = positive(v.high), confidence = number(v.confidence); if (!city || !low || !base || !high || low > base || base > high || confidence < 0 || confidence > 100) throw new Error("INVALID_MARKET_ASSUMPTION"); return { city: city.slice(0, 100), district: text(v.district)?.slice(0, 100) ?? null, building_type: text(v.buildingType)?.slice(0, 100) ?? null, area_min: nullableNumber(v.areaMin), area_max: nullableNumber(v.areaMax), rooms: nullableNumber(v.rooms), resale_price_per_m2_low: low, resale_price_per_m2_base: base, resale_price_per_m2_high: high, confidence, provenance: "USER_ASSUMPTION", active: true }; }
function comparableDataQuality(item: { price: number | null; area: number | null; rooms: number | null; buildingType?: string | null; district?: string | null; renovationConfidence?: string }): number { return Math.min(100, 35 + (item.price ? 15 : 0) + (item.area ? 15 : 0) + (item.rooms ? 10 : 0) + (item.buildingType ? 10 : 0) + (item.district ? 5 : 0) + (item.renovationConfidence === "HIGH" ? 10 : item.renovationConfidence === "MEDIUM" ? 5 : 0)); }
function comparableWeight(similarity: number, freshnessDays: number | null, renovationConfidence: string): number { const freshness = freshnessDays === null ? .1 : freshnessDays <= 30 ? 1 : freshnessDays <= 60 ? .7 : freshnessDays <= 90 ? .4 : .1; const confidence = renovationConfidence === "HIGH" ? 1 : renovationConfidence === "MEDIUM" ? .65 : 0; return Math.round(Math.max(.01, freshness * confidence * Math.max(.25, similarity / 100)) * 1_000) / 1_000; }
function assumptionScore(row: Row, listing: DealListingInput): number { let score = 1; if (!same(text(row.city), listing.city)) return -1; if (row.district && !same(text(row.district), listing.district)) return -1; if (row.district) score += 8; if (row.building_type && !same(text(row.building_type), listing.buildingType)) return -1; if (row.building_type) score += 4; if (row.rooms != null && number(row.rooms) !== listing.rooms) return -1; if (row.rooms != null) score += 2; const area = listing.areaM2; if ((row.area_min != null || row.area_max != null) && (area == null || (row.area_min != null && area < number(row.area_min)) || (row.area_max != null && area > number(row.area_max)))) return -1; if (row.area_min != null || row.area_max != null) score += 3; return score; }
function assumptionMatchLabel(row: Row): string { return [row.city, row.district, row.building_type, row.area_min != null || row.area_max != null ? `${row.area_min ?? "*"}-${row.area_max ?? "*"}m2` : null, row.rooms != null ? `${row.rooms} rooms` : null].filter(Boolean).join(" + "); }
function effectiveText(value: unknown): string | null { return text(object(value).effectiveValue); }
function same(a: string | null, b: string | null): boolean { return Boolean(a && b && normalize(a) === normalize(b)); }
function normalize(v: string): string { return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function exactFacebookUrl(url: string, postId: string | null): boolean { if (!postId || !/^\d+$/.test(postId)) return false; try { const parsed = new URL(url); return /(^|\.)facebook\.com$/i.test(parsed.hostname) && new RegExp(`/(?:posts|permalink)/${postId}(?:/|$)`).test(parsed.pathname); } catch { return false; } }
function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function firstNumber(row: Row, keys: string[]): number | null { for (const key of keys) { const value = nullableNumber(row[key]); if (value !== null) return value; } return null; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function positive(value: unknown): number | null { const v = number(value); return v > 0 ? v : null; }
function nonnegative(value: unknown): number { const v = number(value); if (v < 0) throw new Error("INVALID_NONNEGATIVE_SETTING"); return v; }
function bounded(value: unknown, fallback: number, min: number, max: number): number { const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback; if (parsed < min || parsed > max) throw new Error("INVALID_DECISION_POLICY"); return parsed; }
function bool(value: unknown): boolean | null { return value === true ? true : value === false ? false : null; }
