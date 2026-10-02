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
  { value: "facebook", label: "Facebook Watcher — zebrane oferty" },
  { value: "gratka", label: "Gratka — migracja wymagana" },
  { value: "nieruchomosci_online", label: "Nieruchomosci-online.pl — migracja wymagana" },
  { value: "domiporta", label: "Domiporta" },
  { value: "sprzedajemy", label: "Sprzedajemy.pl" },
  { value: "adresowo", label: "Adresowo.pl" },
  { value: "oferty_net", label: "Oferty.net — migracja wymagana" },
  { value: "szybko", label: "Szybko.pl — wymaga weryfikacji źródła" },
  { value: "bezposrednio", label: "Bezposrednio.net.pl — migracja wymagana" },
  { value: "domy", label: "Domy.pl" },
  { value: "allegro_lokalnie", label: "Allegro Lokalnie" },
  { value: "official_cooperative", label: "Spółdzielnie Łódź — migracja wymagana" },
  { value: "official_uml", label: "UMŁ/BIP Łódź — migracja wymagana" },
  { value: "official_auction", label: "Licytacje i syndycy — migracja wymagana" },
];

/** Shown next to the source picker whenever "facebook" is selected — this filter's Facebook results only ever come from Watcher's own, independently-collected canonical listings; enabling it never starts a new Facebook scan. */
export const FACEBOOK_SOURCE_HELPER_TEXT = "Finder korzysta z ofert zebranych przez Watcher i nie uruchamia nowego skanowania Facebooka.";

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
