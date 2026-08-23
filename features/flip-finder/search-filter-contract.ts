import {
  LISTING_SOURCES,
  MARKET_TYPES,
  type ListingSource,
  type MarketType,
  type SearchFilter,
} from "@/features/flip-finder";

export type SearchFilterInput = Omit<SearchFilter, "id" | "lastScannedAt" | "createdAt" | "updatedAt">;

export type SearchFilterListItem = SearchFilter & {
  totalMatches: number;
  newMatches: number;
  lastScan: SearchFilterScan | null;
};

export type SearchFilterScan = {
  id: string;
  scanRunId?: string | null;
  searchFilterId: string;
  source: ListingSource;
  status: "pending" | "running" | "completed" | "failed" | "partial";
  startedAt: string;
  finishedAt: string | null;
  scannedCount: number;
  matchedCount: number;
  listingsCreated: number;
  newCount: number;
  listingsUpdated: number;
  priceDropCount: number;
  warningsCount: number;
  errorsCount: number;
  errorMessage: string | null;
};

export type SearchFilterListResponse = {
  filters: SearchFilterListItem[];
  latestScan: SearchFilterScan | null;
  summary: {
    activeFilters: number;
    pausedFilters: number;
    listingsCount: number;
    activeListings: number;
    removedListings: number;
    newMatches: number;
  };
};

export const SEARCH_FILTER_SOURCE_OPTIONS: Array<{ value: ListingSource; label: string }> = [
  { value: "otodom", label: "Otodom" },
  { value: "olx", label: "OLX" },
  { value: "morizon", label: "Morizon" },
  { value: "facebook", label: "Facebook" },
];

export function createEmptySearchFilter(): SearchFilterInput {
  return {
    name: "",
    sources: ["otodom", "olx", "morizon"],
    city: "",
    districts: [],
    priceMin: null,
    priceMax: null,
    areaMin: null,
    areaMax: null,
    rooms: [],
    floorMin: null,
    floorMax: null,
    excludeGroundFloor: false,
    excludeTopFloor: false,
    buildingTypes: [],
    ownershipTypes: [],
    marketType: null,
    privateOnly: false,
    maxPricePerSqm: null,
    requiredKeywords: [],
    excludedKeywords: [],
    minFlipScore: null,
    minEstimatedProfit: null,
    maxEstimatedRenovationCost: null,
    scanIntervalMinutes: 60,
    isActive: true,
  };
}

export function isListingSource(value: string): value is ListingSource {
  return LISTING_SOURCES.some((source) => source === value);
}

export function isMarketType(value: string): value is MarketType {
  return MARKET_TYPES.some((marketType) => marketType === value);
}
