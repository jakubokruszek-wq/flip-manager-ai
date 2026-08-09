import { createClient } from "@/lib/supabase/server";
import type { PropertyInvestmentAnalysis } from "@/features/properties/types";

type FinderImport = {
  listingId: string | null;
  title: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  buildingType: string | null;
  ownership: string | null;
  description: string | null;
  images: string[];
  locationText: string | null;
  address: string | null;
  city: string | null;
  district: string | null;
  originalUrl: string;
  normalizedUrl: string;
  source: "otodom" | "olx" | "morizon" | "facebook";
  externalListingId: string | null;
  investmentAnalysis: PropertyInvestmentAnalysis | null;
};

type ImportResponse = { status: "created" | "updated"; propertyId: string };

export async function POST(request: Request) {
  try {
    const listing = await readFinderImport(request);
    const supabase = await createClient();
    developmentLog("PROPERTY FINDER IMPORT RECEIVED:", listing);
    const resolved = await resolveListingReference(supabase, listing);
    const existing = await findExistingProperty(supabase, resolved);
    developmentLog("PROPERTY FINDER IMPORT EXISTING:", { found: Boolean(existing), propertyId: existing?.id ?? null });

    if (existing) {
      const update = {
        ...analysisColumns(resolved.investmentAnalysis),
        ...(resolved.source === "facebook" && resolved.images.length > 0 ? { images: resolved.images, listing_id: resolved.listingId } : {}),
      };
      const { data, error } = await supabase
        .from("properties")
        .update(update)
        .eq("id", existing.id)
        .select("id")
        .single();
      if (error || !data?.id) throw supabaseError("Nie udało się zaktualizować nieruchomości w CRM.", error);
      developmentLog("PROPERTY FINDER IMPORT WRITE:", { operation: "update", propertyId: data.id });
      return Response.json({ status: "updated", propertyId: data.id } satisfies ImportResponse);
    }

    const { data, error } = await supabase
      .from("properties")
      .insert({
        title: resolved.title,
        price: resolved.price,
        area: resolved.area,
        rooms: resolved.rooms,
        floor: databaseFloor(resolved.floor),
        building_type: resolved.buildingType,
        ownership: resolved.ownership,
        rent: null,
        address: resolved.address ?? resolved.locationText ?? resolved.district ?? resolved.city ?? "Nie podano adresu",
        district: resolved.district,
        city: resolved.city,
        notes: resolved.description,
        original_url: resolved.originalUrl,
        normalized_url: resolved.normalizedUrl,
        external_listing_id: resolved.externalListingId,
        listing_id: resolved.listingId,
        source: resolved.source,
        images: resolved.images,
        status: "draft",
        ...analysisColumns(resolved.investmentAnalysis),
      })
      .select("id")
      .single();
    if (error || !data?.id) throw supabaseError("Nie udało się zapisać nieruchomości w CRM.", error);
    developmentLog("PROPERTY FINDER IMPORT WRITE:", { operation: "insert", propertyId: data.id });
    return Response.json({ status: "created", propertyId: data.id } satisfies ImportResponse, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nie udało się dodać nieruchomości do CRM.";
    developmentLog("PROPERTY FINDER IMPORT ERROR:", { message });
    return Response.json({ message }, { status: statusFor(error) });
  }
}

async function resolveListingReference(supabase: Awaited<ReturnType<typeof createClient>>, listing: FinderImport): Promise<FinderImport> {
  if (!listing.listingId) return listing;
  const { data, error } = await supabase.from("listings").select("external_listing_id,normalized_url,images").eq("id", listing.listingId).maybeSingle();
  if (error) throw supabaseError("Nie udało się odczytać identyfikatora oferty.", error);
  const storedImages = stringArray(data?.images);
  return { ...listing, externalListingId: nullableString(data?.external_listing_id) ?? listing.externalListingId, normalizedUrl: nullableString(data?.normalized_url) ?? listing.normalizedUrl, images: listing.source === "facebook" && storedImages.length > 0 ? storedImages : listing.images };
}

async function findExistingProperty(supabase: Awaited<ReturnType<typeof createClient>>, listing: FinderImport): Promise<{ id: string } | null> {
  for (const query of [
    supabase.from("properties").select("id").eq("original_url", listing.originalUrl).maybeSingle(),
    supabase.from("properties").select("id").eq("normalized_url", listing.normalizedUrl).maybeSingle(),
    listing.externalListingId ? supabase.from("properties").select("id").eq("source", listing.source).eq("external_listing_id", listing.externalListingId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]) {
    const { data, error } = await query;
    if (error) throw supabaseError("Schemat CRM nie zawiera wymaganych kolumn importu. Uruchom migrację 20260803130000_complete_property_finder_import.sql.", error);
    if (data?.id && typeof data.id === "string") return { id: data.id };
  }
  return null;
}

function analysisColumns(analysis: PropertyInvestmentAnalysis | null) {
  if (!analysis) return {};
  return { flip_score: analysis.flipScore.score, ai_analysis: analysis.aiAnalysis, market_intelligence: analysis.marketIntelligence, estimated_after_renovation_price: analysis.marketIntelligence.estimatedAfterRenovationPrice, estimated_after_renovation_price_per_sqm: analysis.marketIntelligence.estimatedAfterRenovationPricePerSqm, comparable_count: analysis.marketIntelligence.comparableCount, market_percentile: analysis.marketIntelligence.percentile, recommended_max_price: analysis.purchaseRecommendation.recommendedMaxPrice, negotiation_target: analysis.purchaseRecommendation.negotiationTarget, purchase_decision: analysis.purchaseRecommendation.decision, target_profit: analysis.purchaseRecommendation.targetProfit, target_roi: analysis.purchaseRecommendation.targetRoi, calculator_data: analysis.calculator, purchase_tax: analysis.calculator.purchaseTax, notary_cost: analysis.calculator.notaryCost, purchase_commission: analysis.calculator.purchaseCommission, renovation_cost: analysis.calculator.renovationCost, furnishing_cost: analysis.calculator.furnishingCost, reserve_cost: analysis.calculator.reserveCost, expected_sale_price: analysis.calculator.salePrice, sale_commission: analysis.calculator.saleCommission, tax_cost: analysis.calculator.taxCost, total_cost: analysis.calculator.totalCost, revenue: analysis.calculator.revenue, profit: analysis.calculator.profit, roi: analysis.calculator.roi, margin: analysis.calculator.margin, analysis_completed_at: analysis.analyzedAt, investment_analysis: analysis };
}

async function readFinderImport(request: Request): Promise<FinderImport> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Nieprawidłowe dane oferty.");
  const originalUrl = readUrl(body.originalUrl);
  return { listingId: nullableString(body.id), title: nullableString(body.title), price: nullableNumber(body.price), area: nullableNumber(body.area), rooms: nullableNumber(body.rooms), floor: nullableString(body.floor), buildingType: nullableString(body.buildingType), ownership: nullableString(body.ownership), description: nullableString(body.description), images: stringArray(body.images), locationText: nullableString(body.locationText), address: nullableString(body.address), city: nullableString(body.city), district: nullableString(body.district), originalUrl, normalizedUrl: nullableString(body.normalizedUrl) ?? normalizeUrl(originalUrl), source: sourceValue(body.source), externalListingId: nullableString(body.externalListingId), investmentAnalysis: readInvestmentAnalysis(body.investmentAnalysis) };
}

function readInvestmentAnalysis(value: unknown): PropertyInvestmentAnalysis | null { return isRecord(value) && isRecord(value.flipScore) && isRecord(value.aiAnalysis) && isRecord(value.marketIntelligence) && isRecord(value.purchaseRecommendation) && isRecord(value.calculator) && nullableString(value.analyzedAt) ? value as PropertyInvestmentAnalysis : null; }
function sourceValue(value: unknown): FinderImport["source"] { if (value === "otodom" || value === "olx" || value === "morizon" || value === "facebook") return value; throw new Error("Źródło oferty jest nieobsługiwane."); }
function normalizeUrl(value: string): string { const url = new URL(value); url.hash = ""; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key); return url.toString(); }
function databaseFloor(value: string | null): number | null {
  if (!value) return null;
  if (/\b(?:parter|ground)\b/i.test(value)) return 0;
  if (/\b(?:suterena|piwnica)\b/i.test(value)) return -1;
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

class FinderImportDatabaseError extends Error {
  readonly status = 500;
}

function supabaseError(message: string, error: unknown): FinderImportDatabaseError {
  developmentLog("PROPERTY FINDER IMPORT SUPABASE ERROR:", error);
  const detail = isRecord(error) && typeof error.message === "string" ? error.message : null;
  return new FinderImportDatabaseError(detail ? `${message} Szczegóły: ${detail}` : message);
}

function statusFor(error: unknown): number {
  return error instanceof FinderImportDatabaseError || error instanceof Error && error.message.startsWith("Schemat CRM") ? 500 : 400;
}
function developmentLog(label: string, value: unknown): void { if (process.env.NODE_ENV === "development") console.info(label, value); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }
function readUrl(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("Brakuje adresu oryginalnego ogłoszenia."); let url: URL; try { url = new URL(value); } catch { throw new Error("Adres oryginalnego ogłoszenia jest nieprawidłowy."); } if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) throw new Error("Adres oryginalnego ogłoszenia jest nieprawidłowy."); return url.toString(); }
