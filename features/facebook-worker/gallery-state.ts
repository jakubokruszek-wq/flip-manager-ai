export type MonotonicGalleryStatus = "FAILED" | "PARTIAL" | "COMPLETE";

export type MonotonicGalleryFailure = {
  status: MonotonicGalleryStatus;
  persistedTotal: number;
  total: number;
};

/**
 * A failed hydration must never erase an already persisted gallery. The
 * metadata count is only evidence that a prior exact gallery existed; it is
 * never used to invent new images or increase the gallery total.
 */
export function deriveMonotonicGalleryFailure(input: {
  currentStatus: unknown;
  imageCount: number;
  persistedCount: number;
  total: number;
  exactMetadataCount: number;
}): MonotonicGalleryFailure {
  const imageCount = bounded(input.imageCount);
  const persistedCount = bounded(input.persistedCount);
  const total = bounded(input.total);
  const exactMetadataCount = bounded(input.exactMetadataCount);
  const persistedTotal = Math.max(imageCount, persistedCount);
  const hasPriorResult = persistedTotal > 0 || exactMetadataCount > 0;
  const currentStatus = input.currentStatus === "COMPLETE" ? "COMPLETE" : input.currentStatus === "PARTIAL" ? "PARTIAL" : null;
  const status: MonotonicGalleryStatus = currentStatus === "COMPLETE" ? "COMPLETE" : !hasPriorResult ? "FAILED" : "PARTIAL";
  return { status, persistedTotal, total: Math.max(total, persistedTotal) };
}

function bounded(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(50, Math.floor(value)) : 0;
}
