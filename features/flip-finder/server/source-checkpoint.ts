import type { SourceListing } from "./search-source-registry";
import type { ScanItemCounts } from "../scan-counters";

export type SourceCheckpoint = {
  version: 1;
  cursor: number | null;
  buffer: SourceListing[];
  offset: number;
  complete: boolean;
  fetched: number;
  normalized: number;
  matched: number;
  counters: ScanItemCounts;
  updated: number;
  priceDrops: number;
  warnings: string[];
  timeoutAttempts: number;
};

export function emptySourceCheckpoint(): SourceCheckpoint {
  return { version: 1, cursor: 0, buffer: [], offset: 0, complete: false, fetched: 0, normalized: 0, matched: 0, counters: { listingsCreatedCount: 0, newMatchesCount: 0 }, updated: 0, priceDrops: 0, warnings: [], timeoutAttempts: 0 };
}

/** Stored in existing JSONB, scoped to one source_scans row and lease. */
export function readSourceCheckpoint(snapshot: unknown): SourceCheckpoint {
  if (!snapshot || typeof snapshot !== "object" || !("_finderCheckpoint" in snapshot)) return emptySourceCheckpoint();
  const value = snapshot._finderCheckpoint as SourceCheckpoint;
  if (!value || value.version !== 1 || !Array.isArray(value.buffer) || !Array.isArray(value.warnings)
    || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > value.buffer.length
    || !(value.cursor === null || Number.isInteger(value.cursor) && value.cursor >= 0)
    || !value.counters || ![value.fetched, value.normalized, value.matched, value.updated, value.priceDrops,
      value.counters.listingsCreatedCount, value.counters.newMatchesCount, value.timeoutAttempts].every((count) => Number.isFinite(count) && count >= 0)) {
    // Restarting from a corrupt cursor would silently repeat completed work.
    throw new Error("SOURCE_CHECKPOINT_INVALID");
  }
  return structuredClone(value);
}

export function assertCheckpointSize(checkpoint: SourceCheckpoint): void {
  if (checkpoint.buffer.length > 500 || Buffer.byteLength(JSON.stringify(checkpoint)) > 1_000_000) {
    throw new Error("SOURCE_CHECKPOINT_TOO_LARGE");
  }
}

export class SourceSliceYield extends Error {
  constructor() { super("SOURCE_SLICE_YIELD: saved progress; ready for next portion"); }
}
