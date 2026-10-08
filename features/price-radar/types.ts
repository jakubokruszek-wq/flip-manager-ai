import type { ListingSource } from "@/features/flip-finder";
import type { MarketType } from "@/features/flip-finder";

/** Sources with a real, direct server-side adapter -- excludes facebook (Watcher-only, never a plain HTTP fetch) and anything not yet schema-ready/active for Finder either. See source-availability.ts's SCHEMA_READY_SOURCE_IDS, the single shared source-of-truth this list is filtered from. */
export type RadarSource = Exclude<ListingSource, "facebook" | "bezposrednio" | "official_auction">;

export const DEFAULT_RADAR_DISTRICTS = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"] as const;
export type RadarDistrict = (typeof DEFAULT_RADAR_DISTRICTS)[number];

export type RadarBuildingType = "blok" | "apartamentowiec";
export type RadarRenovationStatus = "fresh_renovation" | "turnkey_finish";

export type RadarSourceAlternative = {
  id: string;
  source: RadarSource;
  originalUrl: string;
  title: string | null;
  price: number;
  area: number;
  rooms: number | null;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  collectedAt: string;
};

export type RadarListing = {
  id: string;
  source: RadarSource;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number;
  area: number;
  pricePerSqm: number;
  rooms: number | null;
  city: string;
  district: string;
  buildingType: RadarBuildingType;
  marketType: MarketType;
  renovationStatus: RadarRenovationStatus;
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Source-provided dates only. Null means the portal did not provide that date. */
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  collectedAt: string;
  /** Only set when a source supplies a stable, explicit cross-portal unit reference. */
  crossSourceIdentity: string | null;
  crossSourceAlternates: RadarSourceAlternative[];
  status: "active" | "removed";
  excludedAt: string | null;
  excludedReason: string | null;
};

export type RadarRunStatus = "pending" | "running" | "completed" | "failed" | "partial";

export type RadarCheckpoint = {
  sourceQueue: RadarSource[];
  currentSourceIndex: number;
  /** Per-source adapter cursor state (page number, continuation token, ...), opaque to collect.ts itself. */
  perSourceCursor: Record<string, unknown>;
  sourceStatuses: Record<string, "pending" | "running" | "completed" | "failed">;
  sourceErrors: Record<string, string>;
  buffer: unknown[];
  bufferOffset: number;
};

export type RadarRun = {
  id: string;
  ownerId: string;
  leaseToken: string | null;
  status: RadarRunStatus;
  startedAt: string;
  finishedAt: string | null;
  checkpoint: RadarCheckpoint;
  scannedCount: number;
  qualifiedCount: number;
  errorMessage: string | null;
  sourceStatuses: Record<string, "pending" | "running" | "completed" | "failed">;
  sourceErrors: Record<string, string>;
};

export type RadarMarketFilter = "secondary" | "primary" | "both";

export type RadarFilters = {
  districts: string[];
  market: RadarMarketFilter;
  areaMin: number | null;
  areaMax: number | null;
  rooms: number[];
  sources: RadarSource[];
};

export const MIN_RADAR_SAMPLE_SIZE = 20;

export type RadarStatGroup = {
  district: string;
  marketType: MarketType;
  averagePricePerSqm: number | null;
  medianPricePerSqm: number | null;
  sampleSize: number;
  isSmallSample: boolean;
  updatedAt: string | null;
};
