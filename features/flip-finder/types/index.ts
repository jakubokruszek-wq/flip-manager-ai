import type { PropertyFinderSource, PropertyListing, PropertyListingStatus, PropertyMarketType } from "@/features/properties/types/property";

export const LISTING_SOURCES = ["otodom", "olx", "morizon", "facebook"] as const;

export type ListingSource = PropertyFinderSource;

export const ACTIVE_SCAN_SOURCES = ["otodom", "olx", "morizon"] as const;

export type ActiveScanSource = (typeof ACTIVE_SCAN_SOURCES)[number];

export function isActiveScanSource(value: string): value is ActiveScanSource {
  return ACTIVE_SCAN_SOURCES.some((source) => source === value);
}

export const LISTING_STATUSES = ["active", "removed", "sold", "watched"] as const;

export type ListingStatus = PropertyListingStatus;

export const SOURCE_SCAN_STATUSES = ["running", "completed", "failed", "partial"] as const;

export type SourceScanStatus = (typeof SOURCE_SCAN_STATUSES)[number];

export const MARKET_TYPES = ["primary", "secondary"] as const;

export type MarketType = PropertyMarketType;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Listing = PropertyListing;

export type ListingSnapshot = {
  id: string;
  listingId: string;
  capturedAt: string;
  price: number | null;
  title: string | null;
  description: string | null;
  images: string[];
  status: ListingStatus;
  rawData: JsonValue;
};

export type SourceScan = {
  id: string;
  searchFilterId: string;
  source: ListingSource;
  startedAt: string;
  finishedAt: string | null;
  status: SourceScanStatus;
  listingsFound: number;
  listingsCreated: number;
  listingsUpdated: number;
  scannedCount: number;
  matchedCount: number;
  newCount: number;
  priceDropCount: number;
  warnings: JsonValue[];
  errorMessage: string | null;
  filterSnapshot: JsonValue;
};

export type SearchFilter = {
  id: string;
  name: string;
  sources: ListingSource[];
  city: string | null;
  districts: string[];
  priceMin: number | null;
  priceMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  rooms: number[];
  floorMin: number | null;
  floorMax: number | null;
  excludeGroundFloor: boolean;
  excludeTopFloor: boolean;
  buildingTypes: string[];
  ownershipTypes: string[];
  marketType: MarketType | null;
  privateOnly: boolean;
  maxPricePerSqm: number | null;
  requiredKeywords: string[];
  excludedKeywords: string[];
  minFlipScore: number | null;
  minEstimatedProfit: number | null;
  maxEstimatedRenovationCost: number | null;
  scanIntervalMinutes: number;
  isActive: boolean;
  lastScannedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListingFilterMatch = {
  listingId: string;
  searchFilterId: string;
  firstMatchedAt: string;
  lastMatchedAt: string;
  matchScore: number | null;
  matchReasons: JsonValue[];
  isCurrentMatch: boolean;
  matchOrigin?: "scan" | "filter_recalculation" | "collector_import";
  sourceScanId?: string | null;
};

export interface ListingSearchAdapter<TSearchParameters = unknown> {
  readonly source: ListingSource;
  toSearchParameters(filter: SearchFilter): TSearchParameters;
}
