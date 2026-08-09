import { createClient } from "@/lib/supabase/server";
import type { Property, PropertyStatus, PropertyWithInvestmentAnalysis } from "@/features/properties/types";
import type { PropertyInvestmentAnalysis } from "@/features/properties/types/investment-analysis";

export async function getProperties(): Promise<PropertyWithInvestmentAnalysis[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("properties").select("*").order("created_at", { ascending: false });
  if (error) throw new Error("Nie udało się pobrać nieruchomości.");
  return (data ?? []).filter(isRecord).map(toProperty);
}

function toProperty(row: Record<string, unknown>): PropertyWithInvestmentAnalysis {
  const price = numberOrNull(row.price);
  const area = numberOrNull(row.area);
  const images = stringArray(row.images);
  const address = stringValue(row.address);
  const district = stringOrNull(row.district);
  const city = stringOrNull(row.city);
  return {
    id: stringValue(row.id), imageUrl: firstImage(images), address,
    status: propertyStatus(row.status), updatedAt: stringValue(row.updated_at) || stringValue(row.created_at),
    source: propertySource(row.source), externalListingId: stringOrNull(row.external_listing_id), originalUrl: stringOrNull(row.original_url), normalizedUrl: stringOrNull(row.normalized_url),
    title: stringOrNull(row.title), description: stringOrNull(row.notes), price, pricePerSqm: price !== null && area !== null && area > 0 ? price / area : null, averagePricePerSqm: null,
    area, rooms: numberOrNull(row.rooms), floor: stringOrNumberOrNull(row.floor), totalFloors: stringOrNumberOrNull(row.total_floors), buildingType: stringOrNull(row.building_type), ownership: stringOrNull(row.ownership), rent: numberOrNull(row.rent),
    district, city, locationText: [address, district, city].filter(Boolean).join(", ") || null, images, thumbnailUrl: firstImage(images), sellerType: stringOrNull(row.seller_type), marketType: marketType(row.market_type), publishedAt: stringOrNull(row.published_at), listingStatus: listingStatus(row.listing_status),
    firstSeenAt: stringOrNull(row.created_at), lastSeenAt: stringOrNull(row.updated_at), removedAt: stringOrNull(row.removed_at), contentHash: stringOrNull(row.content_hash), createdAt: stringOrNull(row.created_at), flipScore: numberOrNull(row.flip_score), purchasePrice: price,
    purchaseTax: numberOrNull(row.purchase_tax), notaryCost: numberOrNull(row.notary_cost), purchaseCommission: numberOrNull(row.purchase_commission), renovationCost: numberOrNull(row.renovation_cost), furnishingCost: numberOrNull(row.furnishing_cost), reserveCost: numberOrNull(row.reserve_cost), expectedSalePrice: numberOrNull(row.expected_sale_price), saleCommission: numberOrNull(row.sale_commission), taxCost: numberOrNull(row.tax_cost), totalCost: numberOrNull(row.total_cost), revenue: numberOrNull(row.revenue), profit: numberOrNull(row.profit), roi: numberOrNull(row.roi), margin: numberOrNull(row.margin), estimatedRenovationCost: numberOrNull(row.estimated_renovation_cost), estimatedSalePrice: numberOrNull(row.estimated_sale_price), estimatedProfit: numberOrNull(row.estimated_profit), estimatedRoi: numberOrNull(row.estimated_roi), investmentAnalysis: investmentAnalysis(row.investment_analysis),
  };
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function stringOrNumberOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function firstImage(value: unknown): string | null { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function propertyStatus(value: unknown): PropertyStatus { return value === "analysis" || value === "acquired" || value === "renovation" || value === "listed" || value === "sold" ? value : "draft"; }
function propertySource(value: unknown): Property["source"] { return value === "otodom" || value === "olx" || value === "facebook" || value === "gratka" || value === "morizon" ? value : null; }
function marketType(value: unknown): Property["marketType"] { return value === "primary" || value === "secondary" ? value : null; }
function listingStatus(value: unknown): Property["listingStatus"] { return value === "active" || value === "removed" || value === "sold" || value === "watched" ? value : null; }
function investmentAnalysis(value: unknown): PropertyInvestmentAnalysis | null {
  if (!isRecord(value) || !isRecord(value.flipScore) || !isRecord(value.aiAnalysis) || !isRecord(value.marketIntelligence) || !isRecord(value.purchaseRecommendation) || !isRecord(value.calculator) || !stringOrNull(value.analyzedAt)) return null;
  return value as PropertyInvestmentAnalysis;
}
