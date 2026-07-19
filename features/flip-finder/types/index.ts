export const LISTING_SOURCES = ["otodom", "olx", "facebook"] as const;

export type ListingSource = (typeof LISTING_SOURCES)[number];

export const LISTING_STATUSES = ["active", "removed", "sold", "watched"] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const SOURCE_SCAN_STATUSES = ["running", "completed", "failed", "partial"] as const;

export type SourceScanStatus = (typeof SOURCE_SCAN_STATUSES)[number];

export const MARKET_TYPES = ["primary", "secondary"] as const;

export type MarketType = (typeof MARKET_TYPES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Listing = {
  id: string;
  source: ListingSource;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string | null;
  title: string | null;
  price: number | null;
  area: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  floor: string | null;
  buildingType: string | null;
  ownership: string | null;
  rent: number | null;
  address: string | null;
  district: string | null;
  city: string | null;
  description: string | null;
  images: string[];
  status: ListingStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
  contentHash: string | null;
  flipScore: number | null;
  estimatedRenovationCost: number | null;
  estimatedSalePrice: number | null;
  estimatedProfit: number | null;
  estimatedRoi: number | null;
  createdAt: string;
  updatedAt: string;
};

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
};

export interface ListingSearchAdapter<TSearchParameters = unknown> {
  readonly source: ListingSource;
  toSearchParameters(filter: SearchFilter): TSearchParameters;
}
