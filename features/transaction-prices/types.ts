export type RcnMarket = "secondary" | "primary";
export type RcnSubject = { city: string | null; street: string | null; area: number | null; price: number | null };
export type RcnRawRow = Record<string, string>;
export type RcnWfsPage = { rows: RcnRawRow[]; returned: number; hasMore: boolean; sourceTimestamp: string | null };
export type RcnComparable = {
  id: string; date: string; street: string; building: string | null;
  area: number; price: number; pricePerM2: number; market: RcnMarket;
};
export type RcnComparison = {
  status: "ready" | "insufficient_data" | "missing_location" | "unsupported_location" | "missing_area";
  source: { title: string; url: string }; street: string | null; market: RcnMarket;
  sampleCount: number; rows: RcnComparable[];
  medianPricePerM2: number | null; q1PricePerM2: number | null; q3PricePerM2: number | null;
  estimatedRange: { low: number; high: number } | null; differencePct: number | null;
  fetchedAt: string; truncated: boolean;
};
