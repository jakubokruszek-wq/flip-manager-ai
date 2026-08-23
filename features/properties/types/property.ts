export type PropertySource = "otodom" | "olx" | "facebook" | "gratka" | "morizon";
export type PropertyDetectedSource = PropertySource | "unknown";
export type PropertyFinderSource = Extract<PropertySource, "otodom" | "olx" | "morizon" | "facebook">;
export type PropertyMarketType = "primary" | "secondary";
export type PropertyListingStatus = "active" | "removed" | "sold" | "watched";
export type PropertyStatus = "draft" | "analysis" | "acquired" | "renovation" | "listed" | "sold";

/** Canonical reusable fields for a residential property or listing. */
export type PropertyFields = {
  source: PropertySource | null;
  externalListingId: string | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  title: string | null;
  description: string | null;
  price: number | null;
  pricePerSqm: number | null;
  averagePricePerSqm: number | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  totalFloors: string | null;
  buildingType: string | null;
  ownership: string | null;
  rent: number | null;
  address: string | null;
  district: string | null;
  city: string | null;
  locationText: string | null;
  images: string[];
  thumbnailUrl: string | null;
  sellerType: string | null;
  marketType: PropertyMarketType | null;
  publishedAt: string | null;
  listingStatus: PropertyListingStatus | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  removedAt: string | null;
  contentHash: string | null;
  createdAt: string | null;
  flipScore: number | null;
  purchasePrice: number | null;
  purchaseTax: number | null;
  notaryCost: number | null;
  purchaseCommission: number | null;
  renovationCost: number | null;
  furnishingCost: number | null;
  reserveCost: number | null;
  expectedSalePrice: number | null;
  saleCommission: number | null;
  taxCost: number | null;
  totalCost: number | null;
  revenue: number | null;
  profit: number | null;
  roi: number | null;
  margin: number | null;
  estimatedRenovationCost: number | null;
  estimatedSalePrice: number | null;
  estimatedProfit: number | null;
  estimatedRoi: number | null;
};

/** CRM representation of a property. */
export type Property = PropertyFields & {
  id: string;
  imageUrl: string | null;
  address: string;
  status: PropertyStatus;
  updatedAt: string;
};

/** Normalized output of an importer. */
export type ImportedProperty = Pick<PropertyFields, "price" | "area" | "rooms" | "floor" | "buildingType" | "ownership" | "rent" | "address" | "district" | "city" | "description" | "images"> & {
  source: PropertySource;
  title: string;
  originalUrl: string;
};

/** Listing gathered by a Flip Finder source before persistence. */
export type PropertySourceListing = Pick<PropertyFields, "title" | "price" | "area" | "rooms" | "floor" | "pricePerSqm" | "city" | "district" | "locationText" | "thumbnailUrl" | "buildingType" | "description"> & {
  /** Optional to keep existing source adapters compatible while allowing gallery persistence. */
  images?: string[];
  publishedAt?: string | null;
  source: Extract<PropertySource, "otodom" | "olx" | "morizon" | "facebook">;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  rawPayload: Record<string, unknown>;
  contentHash: string;
};

/** Listing returned by a source-specific search before it is matched or persisted. */
export type PropertySearchListing = Omit<Pick<PropertyFields, "title" | "price" | "area" | "rooms" | "floor" | "pricePerSqm" | "city" | "district" | "locationText" | "thumbnailUrl" | "sellerType" | "marketType" | "publishedAt">, "marketType"> & {
  source: Extract<PropertySource, "otodom">;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  /** Source value is kept unmodified until it is normalized for the CRM domain. */
  marketType: string | null;
  rawPayload: Record<string, unknown>;
  contentHash: string;
};

/** Property data submitted by the Facebook Collector before it is persisted. */
export type FacebookCollectorPropertyPayload = Pick<
  PropertyFields,
  "title" | "publishedAt" | "price" | "area" | "rooms"
> & {
  sourcePostUrl: string;
  groupName: string | null;
  authorName: string | null;
  content: PropertyFields["description"];
  location: PropertyFields["locationText"];
  imageUrls: PropertyFields["images"];
  collectedAt: string;
};

export type NormalizedFacebookPropertyImport = FacebookCollectorPropertyPayload & {
  normalizedPostUrl: string;
  externalListingId: string;
  contentHash: string;
  pricePerSqm: PropertyFields["pricePerSqm"];
};

/** Listing matched by a Flip Finder filter and ready for display. */
export type PropertyListingResult = Pick<PropertyFields, "title" | "price" | "area" | "rooms" | "floor" | "totalFloors" | "buildingType" | "ownership" | "description" | "images" | "pricePerSqm" | "locationText" | "address" | "city" | "district" | "thumbnailUrl"> & {
  id: string;
  publishedAt?: string | null;
  originalUrl: string;
  source: PropertyFinderSource;
  listingStatus: PropertyListingStatus;
  isActive: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  firstMatchedAt: string;
  lastMatchedAt: string;
  previousPrice: number | null;
  currentPrice: number | null;
  isNew: boolean;
  hasPriceDrop: boolean;
  priceDropAmount: number | null;
  matchReasons: string[];
  unknownFields: string[];
};

/** Persisted Flip Finder listing. */
export type PropertyListing = Pick<PropertyFields, "externalListingId" | "normalizedUrl" | "title" | "price" | "area" | "pricePerSqm" | "rooms" | "floor" | "buildingType" | "ownership" | "rent" | "address" | "district" | "city" | "description" | "images" | "removedAt" | "contentHash" | "flipScore" | "estimatedRenovationCost" | "estimatedSalePrice" | "estimatedProfit" | "estimatedRoi" | "createdAt"> & {
  id: string;
  source: PropertyFinderSource;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string | null;
  status: PropertyListingStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PropertyCalculator = Pick<PropertyFields, "purchasePrice" | "purchaseTax" | "notaryCost" | "purchaseCommission" | "renovationCost" | "furnishingCost" | "reserveCost" | "expectedSalePrice" | "saleCommission" | "taxCost" | "totalCost" | "revenue" | "profit" | "roi" | "margin">;

export type PropertyAnalysisInput = Pick<PropertyFields, "price" | "pricePerSqm" | "averagePricePerSqm" | "area" | "rooms" | "floor" | "marketType" | "title" | "description"> & { flipScore: number };

export type PropertyAnalysis = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  recommendations: string[];
  estimatedRenovation: { min: number; max: number };
  estimatedProfit: number | null;
  confidence: number;
};

export type FlipScoreInput = Pick<PropertyFields, "price" | "pricePerSqm" | "averagePricePerSqm" | "rooms" | "area" | "marketType" | "title" | "description">;
export type FlipScoreLabel = "Słaby" | "Dobry" | "Bardzo dobry" | "Okazja";
export type FlipScoreResult = { score: number; label: FlipScoreLabel; reasons: string[]; risks: string[] };

export type PropertyFormValues = {
  title: string;
  price: string;
  area: string;
  rooms: string;
  floor: string;
  buildingType: string;
  ownership: string;
  rent: string;
  address: string;
  district: string;
  city: string;
  description: string;
  originalUrl: string;
  source: string;
};

export type PropertySaveRequest = PropertyFormValues & { images: string[] };

export type PropertiesInsert = {
  title: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: string | null;
  building_type: string | null;
  ownership: string | null;
  rent: number | null;
  address: string;
  district: string | null;
  city: string | null;
  notes: string | null;
  original_url: string | null;
  source: Extract<PropertySource, "otodom" | "facebook">;
  images: string[];
  status: "draft";
};
