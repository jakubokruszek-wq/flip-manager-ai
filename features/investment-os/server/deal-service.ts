import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { calculateResaleArv, selectResaleComps } from "@/features/market-intelligence/resale-arv";
import type { ResaleCompRecord } from "@/features/market-intelligence/resale-comps";
import { DEFAULT_UNDERWRITING_SETTINGS, type UnderwritingSettings } from "@/features/flip-finder/underwriting";
import { buildCanonicalDeal, downstreamForChange, fingerprintsEqual } from "../engine";
import type { CanonicalDeal, DealFactOverrides, DealListingInput, MarketEvidence } from "../types";

type Row = Record<string, unknown>;

export async function getInvestmentDeal(listingId: string): Promise<CanonicalDeal | null> {
  const db = createAdminClient();
  const { data: listing, error } = await db.from("listings").select("id,source,original_url,external_listing_id,lifecycle_status,manual_decision,city,district,address,area,rooms,floor,building_type,ownership,description,rent,price,price_per_sqm,gallery_status,images").eq("id", listingId).maybeSingle();
  if (error) throw error;
  if (!listing) return null;
  const existing = await db.from("deals").select("*").eq("listing_id", listingId).maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") throw existing.error;
  const dealId = text(existing.data?.id) ?? crypto.randomUUID();
  const overridesResult = existing.data ? await db.from("deal_fact_overrides").select("values").eq("deal_id", dealId).maybeSingle() : { data: null, error: null };
  if (overridesResult.error) throw overridesResult.error;
  const settings = await loadSettings(db);
  const listingInput = toListingInput(listing as Row);
  const market = await resolveMarketEvidence(db, listingInput);
  const now = new Date().toISOString();
  const deal = buildCanonicalDeal({ dealId, listing: listingInput, overrides: object(overridesResult.data?.values) as DealFactOverrides, market, settings, now, createdAt: text(existing.data?.created_at) ?? undefined });
  const old = existing.data ? toCanonicalDeal(existing.data as Row) : null;
  const settled = old && [old.scout, old.verify, old.market, old.underwriting, old.ceo].every((director) => director.status === "COMPLETE" || director.status === "BLOCKED");
  if (old && settled && fingerprintsEqual(old, deal)) return old;
  if (!old || !fingerprintsEqual(old, deal) || !settled) {
    const { error: writeError } = await db.from("deals").upsert(toDealRow(deal), { onConflict: "listing_id" });
    if (writeError) throw writeError;
  }
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
  const stale = (value: unknown, director: string) => ({ ...object(value), director, status: "STALE" });
  const staleValues: Row = {};
  const directorKey = (name: string): "verify" | "market" | "underwriting" | "ceo" => name === "UNDERWRITER" ? "underwriting" : name.toLowerCase() as "verify" | "market" | "ceo";
  for (const name of invalidated) { const key = directorKey(name); staleValues[key] = stale(current[key], name); }
  if (Object.keys(staleValues).length) { const { error: staleError } = await db.from("deals").update(staleValues).eq("id", current.id); if (staleError) throw staleError; }
  const { error } = await db.from("deal_fact_overrides").upsert({ deal_id: current.id, values: clean }, { onConflict: "deal_id" });
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

async function loadSettings(db: ReturnType<typeof createAdminClient>): Promise<UnderwritingSettings> {
  const { data, error } = await db.from("underwriting_settings").select("values").eq("id", "default").maybeSingle();
  if (error) throw error;
  return validateSettings(data?.values ?? DEFAULT_UNDERWRITING_SETTINGS);
}

async function resolveMarketEvidence(db: ReturnType<typeof createAdminClient>, listing: DealListingInput): Promise<MarketEvidence | null> {
  const { data: rows, error } = await db.from("resale_comps").select("*").eq("active", true).limit(500);
  if (error && error.code !== "42P01") throw error;
  const comps = (rows ?? []).map(toComp).filter((item): item is ResaleCompRecord => item !== null);
  const selected = selectResaleComps({ id: listing.id, area: listing.areaM2, rooms: listing.rooms, city: listing.city, district: listing.district, address: listing.street, buildingType: listing.buildingType, floor: listing.floor }, comps);
  const arv = calculateResaleArv({ area: listing.areaM2 }, selected);
  if (arv.conservativePrice && arv.expectedPrice && arv.optimisticPrice && listing.areaM2) return { id: null, matchedBy: "RESALE_COMPS", low: arv.conservativePrice / listing.areaM2, base: arv.expectedPrice / listing.areaM2, high: arv.optimisticPrice / listing.areaM2, confidence: Math.min(90, 45 + selected.length * 5), provenance: "DERIVED", compCount: selected.length };
  const { data: assumptions, error: assumptionError } = await db.from("market_assumptions").select("*").eq("active", true).eq("city", listing.city ?? "").order("effective_from", { ascending: false });
  if (assumptionError) throw assumptionError;
  const matched = (assumptions ?? []).map((row) => ({ row: row as Row, score: assumptionScore(row as Row, listing) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score)[0]?.row;
  if (!matched) return null;
  return { id: text(matched.id), matchedBy: assumptionMatchLabel(matched), low: number(matched.resale_price_per_m2_low), base: number(matched.resale_price_per_m2_base), high: number(matched.resale_price_per_m2_high), confidence: number(matched.confidence), provenance: matched.provenance === "MARKET_ASSUMPTION" ? "MARKET_ASSUMPTION" : "USER_ASSUMPTION", compCount: 0 };
}

function toListingInput(row: Row): DealListingInput {
  const lifecycle = text(row.lifecycle_status); const manual = row.manual_decision === "ACCEPTED" || row.manual_decision === "REJECTED" ? row.manual_decision : null;
  const externalListingId = text(row.external_listing_id); const sourceUrl = text(row.original_url)!; const source = text(row.source)!;
  return { id: text(row.id)!, source, sourceUrl, externalListingId, lifecycleStatus: lifecycle, decisionBucket: lifecycle === "REJECTED" ? "REJECTED" : lifecycle === "REVIEW" ? "REVIEW" : "MATCHED", manualDecision: manual, city: text(row.city), district: text(row.district), street: text(row.address), areaM2: nullableNumber(row.area), rooms: nullableNumber(row.rooms), floor: text(row.floor), floorsTotal: null, buildingType: text(row.building_type), yearBuilt: null, ownership: text(row.ownership), condition: text(row.description), monthlyFee: nullableNumber(row.rent), askingPrice: nullableNumber(row.price), askingPricePerM2: nullableNumber(row.price_per_sqm), galleryStatus: text(row.gallery_status), imageCount: Array.isArray(row.images) ? row.images.length : 0, identityExact: source !== "facebook" || exactFacebookUrl(sourceUrl, externalListingId) };
}

function toComp(row: Row): ResaleCompRecord | null {
  const id = text(row.id), source = text(row.source), externalListingId = text(row.external_listing_id), lastSeenAt = text(row.last_seen_at);
  if (!id || !externalListingId || !lastSeenAt || !["facebook", "otodom", "olx", "morizon"].includes(source ?? "")) return null;
  const renovationStatus = ["RENOVATED", "MOVE_IN_READY", "REFRESHED", "UNKNOWN"].includes(text(row.renovation_status) ?? "") ? text(row.renovation_status)! as ResaleCompRecord["classification"]["renovationStatus"] : "UNKNOWN";
  const renovationConfidence = ["HIGH", "MEDIUM", "LOW"].includes(text(row.renovation_confidence) ?? "") ? text(row.renovation_confidence)! as ResaleCompRecord["classification"]["renovationConfidence"] : "LOW";
  return { id, source: source as ResaleCompRecord["source"], externalListingId, canonicalUrl: text(row.canonical_url), title: text(row.title), description: text(row.description), city: text(row.city), district: text(row.district), street: text(row.street), address: text(row.address), latitude: nullableNumber(row.latitude), longitude: nullableNumber(row.longitude), price: nullableNumber(row.price), areaM2: nullableNumber(row.area_m2), pricePerM2: nullableNumber(row.price_per_m2), rooms: nullableNumber(row.rooms), floor: text(row.floor), floors: text(row.floors), buildingType: text(row.building_type), constructionYear: nullableNumber(row.construction_year), ownership: text(row.ownership), balcony: bool(row.balcony), elevator: bool(row.elevator), parking: bool(row.parking), listingCreatedAt: text(row.listing_created_at), firstSeenAt: text(row.first_seen_at) ?? lastSeenAt, lastSeenAt, active: row.active === true, sellerType: text(row.seller_type), fingerprint: text(row.fingerprint), classification: { isCandidate: true, renovationStatus, renovationConfidence, finishLevel: text(row.finish_level), evidence: [], outlierReason: text(row.outlier_reason), exclusionReason: null } };
}

function toDealRow(deal: CanonicalDeal): Row { return { id: deal.id, listing_id: deal.listingId, stage: deal.stage, facts_fingerprint: deal.factsFingerprint, facts: deal.facts, scout: deal.scout, verify: deal.verify, market: deal.market, underwriting: deal.underwriting, ceo: deal.ceo, playbook: deal.playbook, created_at: deal.createdAt, updated_at: deal.updatedAt }; }
function toCanonicalDeal(row: Row): CanonicalDeal { return { id: text(row.id)!, listingId: text(row.listing_id)!, stage: text(row.stage)! as CanonicalDeal["stage"], factsFingerprint: text(row.facts_fingerprint)!, facts: object(row.facts) as CanonicalDeal["facts"], scout: object(row.scout) as CanonicalDeal["scout"], verify: object(row.verify) as CanonicalDeal["verify"], market: object(row.market) as CanonicalDeal["market"], underwriting: object(row.underwriting) as CanonicalDeal["underwriting"], ceo: object(row.ceo) as CanonicalDeal["ceo"], playbook: object(row.playbook) as CanonicalDeal["playbook"], createdAt: text(row.created_at)!, updatedAt: text(row.updated_at)! }; }
function sanitizeOverrides(value: DealFactOverrides): DealFactOverrides { const allowed = new Set(["city","district","street","areaM2","rooms","floor","floorsTotal","buildingType","yearBuilt","ownership","condition","monthlyFee","askingPrice","resalePerM2","renovationPerM2","holdingMonths","additionalCosts"]); return Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.has(key) && (item === null || typeof item === "string" || typeof item === "number") && !(typeof item === "number" && (!Number.isFinite(item) || item < 0)))); }
function validateSettings(value: unknown): UnderwritingSettings { const v = object(value); const renovation = object(v.renovationPerM2), market = object(v.marketResalePerM2); const result: UnderwritingSettings = { ...DEFAULT_UNDERWRITING_SETTINGS, ...v, renovationPerM2: { LIGHT: nonnegative(renovation.LIGHT), STANDARD: nonnegative(renovation.STANDARD), FULL: nonnegative(renovation.FULL) }, marketResalePerM2: { low: nonnegative(market.low), base: nonnegative(market.base), high: nonnegative(market.high) }, marketResaleProvenance: "USER_ASSUMPTION" } as UnderwritingSettings; for (const key of ["contingencyPercent","purchaseTaxPercent","purchaseCommissionPercent","salesCostPercent","financingAnnualRatePercent","financingLoanPercent","minimumMarginPercent","minimumROI","targetNegotiationBufferPercent"] as const) if (result[key] < 0 || result[key] > 100) throw new Error(`INVALID_SETTING_${key}`); return result; }
function validateAssumption(value: unknown): Row { const v = object(value); const city = text(v.city); const low = positive(v.low), base = positive(v.base), high = positive(v.high), confidence = number(v.confidence); if (!city || !low || !base || !high || low > base || base > high || confidence < 0 || confidence > 100) throw new Error("INVALID_MARKET_ASSUMPTION"); return { city: city.slice(0, 100), district: text(v.district)?.slice(0, 100) ?? null, building_type: text(v.buildingType)?.slice(0, 100) ?? null, area_min: nullableNumber(v.areaMin), area_max: nullableNumber(v.areaMax), rooms: nullableNumber(v.rooms), resale_price_per_m2_low: low, resale_price_per_m2_base: base, resale_price_per_m2_high: high, confidence, provenance: "USER_ASSUMPTION", active: true }; }
function assumptionScore(row: Row, listing: DealListingInput): number { let score = 1; if (!same(text(row.city), listing.city)) return -1; if (row.district && !same(text(row.district), listing.district)) return -1; if (row.district) score += 8; if (row.building_type && !same(text(row.building_type), listing.buildingType)) return -1; if (row.building_type) score += 4; if (row.rooms != null && number(row.rooms) !== listing.rooms) return -1; if (row.rooms != null) score += 2; const area = listing.areaM2; if ((row.area_min != null || row.area_max != null) && (area == null || (row.area_min != null && area < number(row.area_min)) || (row.area_max != null && area > number(row.area_max)))) return -1; if (row.area_min != null || row.area_max != null) score += 3; return score; }
function assumptionMatchLabel(row: Row): string { return [row.city, row.district, row.building_type, row.area_min != null || row.area_max != null ? `${row.area_min ?? "*"}-${row.area_max ?? "*"}m2` : null, row.rooms != null ? `${row.rooms} rooms` : null].filter(Boolean).join(" + "); }
function effectiveText(value: unknown): string | null { return text(object(value).effectiveValue); }
function same(a: string | null, b: string | null): boolean { return Boolean(a && b && normalize(a) === normalize(b)); }
function normalize(v: string): string { return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function exactFacebookUrl(url: string, postId: string | null): boolean { if (!postId || !/^\d+$/.test(postId)) return false; try { const parsed = new URL(url); return /(^|\.)facebook\.com$/i.test(parsed.hostname) && new RegExp(`/(?:posts|permalink)/${postId}(?:/|$)`).test(parsed.pathname); } catch { return false; } }
function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function positive(value: unknown): number | null { const v = number(value); return v > 0 ? v : null; }
function nonnegative(value: unknown): number { const v = number(value); if (v < 0) throw new Error("INVALID_NONNEGATIVE_SETTING"); return v; }
function bool(value: unknown): boolean | null { return value === true ? true : value === false ? false : null; }
