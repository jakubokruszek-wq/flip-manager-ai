import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getProperties } from "@/services/properties.service";
import type { PropertyWithInvestmentAnalysis } from "@/features/properties/types";
import type {
  AttentionReason,
  DashboardDayPoint,
  DashboardPriceDrop,
  DashboardScan,
  DashboardSummary,
  PurchaseDecision,
} from "@/features/dashboard/types";

const DAY_MS = 86_400_000;
const STALE_ANALYSIS_DAYS = 30;
const WEAK_ROI_THRESHOLD = 10;

type Row = Record<string, unknown>;

export async function getDashboardSummary(now = new Date()): Promise<DashboardSummary> {
  const supabase = await createClient();
  const fourteenDaysAgo = new Date(startOfDay(now).getTime() - 13 * DAY_MS).toISOString();

  const [properties, propertyLinksResult, listingsResult, matchesResult, scansResult, snapshotsResult] = await Promise.all([
    getProperties(),
    supabase.from("properties").select("id,listing_id"),
    supabase.from("listings").select("id,title,district,images,status,price").order("last_seen_at", { ascending: false }),
    supabase.from("listing_filter_matches").select("listing_id,first_matched_at").gte("first_matched_at", fourteenDaysAgo),
    supabase.from("source_scans").select("*").order("started_at", { ascending: false }).limit(8),
    supabase.from("listing_snapshots").select("listing_id,captured_at,price").order("captured_at", { ascending: true }),
  ]);

  const queryError = propertyLinksResult.error ?? listingsResult.error ?? matchesResult.error ?? scansResult.error ?? snapshotsResult.error;
  if (queryError) {
    console.error("DASHBOARD SUMMARY ERROR:", queryError);
    throw new Error("Nie udało się pobrać danych dashboardu.");
  }

  const listings = rows(listingsResult.data);
  const matches = rows(matchesResult.data);
  const scans = rows(scansResult.data);
  const snapshots = rows(snapshotsResult.data);
  const listingById = new Map(listings.map((listing) => [stringValue(listing.id), listing]));
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const propertyByListingId = new Map(
    rows(propertyLinksResult.data).flatMap((link) => {
      const property = propertyById.get(stringValue(link.id));
      const listingId = nullableString(link.listing_id);
      return property && listingId ? [[listingId, property] as const] : [];
    }),
  );
  const priceDrops = findPriceDrops(snapshots, listingById, propertyByListingId);
  const activeProperties = properties.filter((property) => property.status !== "sold");
  const analyzedProperties = activeProperties.filter(hasAnalysisMetrics);
  const cutoff24h = now.getTime() - DAY_MS;
  const newListingIds = new Set(
    matches.filter((match) => dateMs(match.first_matched_at) >= cutoff24h).map((match) => stringValue(match.listing_id)),
  );

  const topOpportunities = analyzedProperties
    .map((property) => ({
      property,
      flipScore: metric(property.flipScore, property.investmentAnalysis?.flipScore.score),
      roi: metric(property.roi, property.investmentAnalysis?.calculator.roi),
      potentialProfit: metric(property.profit, property.investmentAnalysis?.calculator.profit, property.estimatedProfit),
      decision: decision(property.investmentAnalysis?.purchaseRecommendation.decision),
    }))
    .sort((a, b) => opportunityRank(b) - opportunityRank(a))
    .slice(0, 5);

  return {
    generatedAt: now.toISOString(),
    kpis: {
      activeProperties: activeProperties.length,
      newOpportunities24h: newListingIds.size,
      averageFlipScore: average(analyzedProperties.map((property) => metric(property.flipScore, property.investmentAnalysis?.flipScore.score))),
      averageRoi: average(analyzedProperties.map((property) => metric(property.roi, property.investmentAnalysis?.calculator.roi))),
      potentialProfit: analyzedProperties.reduce((total, property) => total + (metric(property.profit, property.investmentAnalysis?.calculator.profit, property.estimatedProfit) ?? 0), 0),
      priceDrops: priceDrops.length,
    },
    topOpportunities,
    recentScans: scans.map(toScan),
    opportunitiesByDay: buildDailySeries(matches, now),
    profitByProperty: analyzedProperties
      .flatMap((property) => {
        const profit = metric(property.profit, property.investmentAnalysis?.calculator.profit, property.estimatedProfit);
        return profit === null ? [] : [{ propertyId: property.id, label: property.title ?? property.address, profit }];
      })
      .sort((a, b) => b.profit - a.profit),
    recentPriceDrops: priceDrops.slice(0, 6),
    attentionItems: activeProperties
      .map((property) => ({ property, reasons: attentionReasons(property, now) }))
      .filter((item) => item.reasons.length > 0)
      .sort((a, b) => b.reasons.length - a.reasons.length)
      .slice(0, 8),
  };
}

function findPriceDrops(
  snapshots: Row[],
  listingById: Map<string, Row>,
  propertyByListingId: Map<string, PropertyWithInvestmentAnalysis>,
): DashboardPriceDrop[] {
  const grouped = new Map<string, Row[]>();
  for (const snapshot of snapshots) {
    const listingId = stringValue(snapshot.listing_id);
    if (listingId) grouped.set(listingId, [...(grouped.get(listingId) ?? []), snapshot]);
  }

  return [...grouped.entries()].flatMap(([listingId, history]) => history.flatMap((snapshot, index) => {
    if (index === 0) return [];
    const previousPrice = numberValue(history[index - 1].price);
    const currentPrice = numberValue(snapshot.price);
    if (previousPrice === null || currentPrice === null || currentPrice >= previousPrice) return [];
    const listing = listingById.get(listingId);
    const property = propertyByListingId.get(listingId);
    return [{
      listingId,
      propertyId: property?.id ?? null,
      title: stringValue(listing?.title) || property?.title || property?.address || "Oferta bez tytułu",
      district: nullableString(listing?.district) ?? property?.district ?? null,
      imageUrl: firstImage(listing?.images) ?? property?.imageUrl ?? null,
      previousPrice,
      currentPrice,
      dropAmount: previousPrice - currentPrice,
      droppedAt: stringValue(snapshot.captured_at),
    }];
  })).sort((a, b) => dateMs(b.droppedAt) - dateMs(a.droppedAt));
}

function buildDailySeries(matches: Row[], now: Date): DashboardDayPoint[] {
  const start = startOfDay(new Date(now.getTime() - 13 * DAY_MS));
  const counts = new Map<string, Set<string>>();
  for (const match of matches) {
    const date = nullableString(match.first_matched_at);
    const listingId = nullableString(match.listing_id);
    if (!date || !listingId) continue;
    const key = dayKey(new Date(date));
    counts.set(key, new Set([...(counts.get(key) ?? []), listingId]));
  }
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = dayKey(date);
    return { date: key, count: counts.get(key)?.size ?? 0 };
  });
}

function toScan(row: Row): DashboardScan {
  const status = row.status === "running" || row.status === "failed" || row.status === "partial" ? row.status : "completed";
  const errors = status === "failed" ? 1 : arrayLength(row.diagnostics) + (nullableString(row.error_message) ? 1 : 0);
  return {
    id: stringValue(row.id), source: stringValue(row.source), startedAt: stringValue(row.started_at), status,
    fetched: integer(row.scanned_count) || integer(row.listings_found),
    newMatches: integer(row.new_count) || integer(row.matched_count),
    priceDrops: integer(row.price_drop_count), sourceErrors: errors, errorMessage: nullableString(row.error_message),
  };
}

function attentionReasons(property: PropertyWithInvestmentAnalysis, now: Date): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const analysis = property.investmentAnalysis;
  const roi = metric(property.roi, analysis?.calculator.roi);
  const renovation = metric(property.renovationCost, analysis?.calculator.renovationCost, property.estimatedRenovationCost);
  if (!analysis && !property.flipScore) reasons.push("missing_analysis");
  if (renovation === null || renovation <= 0) reasons.push("missing_budget");
  if (analysis && now.getTime() - dateMs(analysis.analyzedAt) > STALE_ANALYSIS_DAYS * DAY_MS) reasons.push("stale_analysis");
  if (roi !== null && roi < WEAK_ROI_THRESHOLD) reasons.push("weak_roi");
  if (property.listingStatus === "removed" || property.removedAt) reasons.push("removed_listing");
  return reasons;
}

function hasAnalysisMetrics(property: PropertyWithInvestmentAnalysis): boolean {
  return Boolean(property.investmentAnalysis) || metric(property.flipScore, property.roi, property.profit) !== null;
}
function opportunityRank(item: { decision: PurchaseDecision | null; flipScore: number | null; roi: number | null; potentialProfit: number | null }): number {
  const decisionScore = item.decision === "buy" ? 3 : item.decision === "negotiate" ? 2 : item.decision === "reject" ? 1 : 0;
  return decisionScore * 1_000_000_000 + (item.flipScore ?? 0) * 1_000_000 + (item.roi ?? 0) * 10_000 + (item.potentialProfit ?? 0);
}
function decision(value: unknown): PurchaseDecision | null { return value === "buy" || value === "negotiate" || value === "reject" ? value : null; }
function metric(...values: unknown[]): number | null { for (const value of values) { const number = numberValue(value); if (number !== null) return number; } return null; }
function average(values: Array<number | null>): number | null { const numbers = values.filter((value): value is number => value !== null); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function numberValue(value: unknown): number | null { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN; return Number.isFinite(number) ? number : null; }
function integer(value: unknown): number { return Math.max(0, Math.trunc(numberValue(value) ?? 0)); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableString(value: unknown): string | null { const text = stringValue(value).trim(); return text || null; }
function firstImage(value: unknown): string | null { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null; }
function arrayLength(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function dateMs(value: unknown): number { const time = new Date(stringValue(value)).getTime(); return Number.isFinite(time) ? time : 0; }
function startOfDay(date: Date): Date { const result = new Date(date); result.setHours(0, 0, 0, 0); return result; }
function dayKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
