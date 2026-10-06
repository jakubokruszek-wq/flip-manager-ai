import type { PropertySourceListing } from "@/features/properties/types/property";

/** A committed cursor points to the next page/site, never to a new scan. */
export type SourceBatch = { listings: PropertySourceListing[]; warnings: string[]; fetched: number };
export type SourceBatchContext = {
  cursor?: number;
  onBatch(batch: SourceBatch, nextCursor: number | null): Promise<void>;
};
