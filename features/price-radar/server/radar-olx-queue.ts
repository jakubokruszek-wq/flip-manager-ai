import "server-only";

export type RadarOlxQueueJob = { id: string; status: "queued" | "running" | "completed" };

/**
 * OLX was removed from Price Radar (it stays a Flip Finder-only source; see
 * docs/radar-olx-removal.md). This former entry point refuses before any
 * read or write: Radar can neither create nor resume (STOP -> queued) an OLX
 * job. The database enforces the same rule independently (trigger
 * olx_scan_jobs_block_price_radar, migration 20261016120000).
 */
export async function enqueueRadarOlxJob(input: { ownerId: string; runId: string; leaseToken: string; city: string }, client?: unknown): Promise<RadarOlxQueueJob> {
  void input; void client;
  throw new Error("RADAR_OLX_REMOVED");
}
