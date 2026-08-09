export type MarketType = "primary" | "secondary";

export type MarketListing = {
  id: string;
  title: string | null;
  description: string | null;
  originalUrl: string | null;
  normalizedUrl: string | null;
  price: number | null;
  area: number | null;
  pricePerSqm: number | null;
  rooms: number | null;
  address: string | null;
  district: string | null;
  city: string | null;
  source: string;
  status: string;
  lastSeenAt: string;
  marketTypes: MarketType[];
};

export type ComparableListing = Pick<
  MarketListing,
  "id" | "title" | "originalUrl" | "normalizedUrl" | "price" | "area" | "pricePerSqm" | "rooms" | "address" | "district" | "city" | "source" | "lastSeenAt"
> & {
  similarityScore: number;
  matchReasons: string[];
};

export type PriceStatistics = {
  average: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  q1: number | null;
  q3: number | null;
  standardDeviation: number | null;
};

export type MarketIntelligence = {
  listingId: string;
  districtAverage: number | null;
  streetAverage: number | null;
  averagePricePerSqm: number | null;
  median: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
  standardDeviation: number | null;
  currentPrice: number | null;
  currentPricePerSqm: number | null;
  estimatedAfterRenovationPrice: number | null;
  estimatedAfterRenovationPricePerSqm: number | null;
  estimatedValueIncrease: number | null;
  priceDifference: number | null;
  percentageDifference: number | null;
  ranking: number | null;
  percentile: number | null;
  comparableCount: number;
  comparables: ComparableListing[];
};
