import type { FacebookWatcherListing, FacebookWorkflowStatus } from "./types";

export type FacebookInboxSort = "newest" | "opportunity" | "flip" | "price_per_sqm" | "price" | "profit";
export type FacebookInboxFilters = {
  query: string; neighborhood: string; district: string; group: string;
  maxPrice: number | null; maxPricePerSqm: number | null; rooms: number | null;
  minFlipScore: number | null; minOpportunityScore: number | null;
  sellerType: "all" | "private" | "agency"; condition: "all" | "renovation" | "ready";
  publishedDays: number | null;
};

export const EMPTY_FACEBOOK_INBOX_FILTERS: FacebookInboxFilters = { query: "", neighborhood: "", district: "", group: "", maxPrice: null, maxPricePerSqm: null, rooms: null, minFlipScore: null, minOpportunityScore: null, sellerType: "all", condition: "all", publishedDays: null };

export function filterFacebookInbox(items: FacebookWatcherListing[], status: FacebookWorkflowStatus | "all", filters: FacebookInboxFilters, now = Date.now()): FacebookWatcherListing[] {
  const query = normalize(filters.query);
  return items.filter((item) => {
    if (status !== "all" && item.workflowStatus !== status) return false;
    if (query && ![item.title, item.description, item.street, item.neighborhood, item.groupName].some((value) => normalize(value).includes(query))) return false;
    if (filters.neighborhood && normalize(item.neighborhood) !== normalize(filters.neighborhood)) return false;
    if (filters.district && normalize(item.district) !== normalize(filters.district)) return false;
    if (filters.group && normalize(item.groupName) !== normalize(filters.group)) return false;
    if (filters.maxPrice !== null && (item.price === null || item.price > filters.maxPrice)) return false;
    if (filters.maxPricePerSqm !== null && (item.pricePerSqm === null || item.pricePerSqm > filters.maxPricePerSqm)) return false;
    if (filters.rooms !== null && item.rooms !== filters.rooms) return false;
    if (filters.minFlipScore !== null && item.flipScore < filters.minFlipScore) return false;
    if (filters.minOpportunityScore !== null && item.opportunityScore < filters.minOpportunityScore) return false;
    if (filters.sellerType !== "all" && item.sellerType !== filters.sellerType) return false;
    if (filters.condition !== "all" && item.condition !== filters.condition) return false;
    if (filters.publishedDays !== null) {
      const date = Date.parse(item.publishedAt ?? item.importedAt);
      if (!Number.isFinite(date) || now - date > filters.publishedDays * 86_400_000) return false;
    }
    return true;
  });
}

export function sortFacebookInbox(items: FacebookWatcherListing[], sort: FacebookInboxSort): FacebookWatcherListing[] {
  return [...items].sort((left, right) => {
    if (sort === "opportunity") return right.opportunityScore - left.opportunityScore;
    if (sort === "flip") return right.flipScore - left.flipScore;
    if (sort === "price_per_sqm") return ascendingNullable(left.pricePerSqm, right.pricePerSqm);
    if (sort === "price") return ascendingNullable(left.price, right.price);
    if (sort === "profit") return descendingNullable(left.potentialProfit, right.potentialProfit);
    return timestamp(right.publishedAt ?? right.importedAt) - timestamp(left.publishedAt ?? left.importedAt);
  });
}

export function opportunityLabel(score: number): string | null {
  if (score >= 90) return "Wyjątkowa okazja";
  if (score >= 85) return "Bardzo dobra";
  if (score >= 75) return "Warta analizy";
  return null;
}

function normalize(value: string | null): string { return (value ?? "").normalize("NFC").trim().toLocaleLowerCase("pl-PL"); }
function timestamp(value: string): number { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
function ascendingNullable(left: number | null, right: number | null): number { if (left === null) return 1; if (right === null) return -1; return left - right; }
function descendingNullable(left: number | null, right: number | null): number { if (left === null) return 1; if (right === null) return -1; return right - left; }
