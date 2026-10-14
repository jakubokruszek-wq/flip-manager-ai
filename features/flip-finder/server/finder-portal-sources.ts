import { activeSources } from "@/features/flip-finder/server/search-source-registry";

/**
 * The portals of a Finder scan: every active source except OLX. OLX stays
 * selected in search_filters.sources (the separate OLX schedule reads it) but
 * is never a stage of a Finder run -- neither "Skanuj", nor the automatic
 * 5-hour cycle, nor a resume or continuation queues or waits for an OLX job.
 * Automatic OLX jobs come only from the independent schedule
 * (finder-olx-schedule.ts), claimed by the scheduled Cloudflare Worker; their
 * listings still reach the filter's results through the shared OLX pipeline.
 */
export const FINDER_SEPARATE_SOURCES: ReadonlySet<string> = new Set(["olx"]);

export function finderPortalSources(filter: Parameters<typeof activeSources>[0]): ReturnType<typeof activeSources> {
  return activeSources(filter).filter((source) => !FINDER_SEPARATE_SOURCES.has(source.id));
}

/** A filter whose only active source is separate (OLX): nothing for a Finder run to scan. */
export const OLX_ONLY_FILTER_MESSAGE = "OLX jest pobierany wyłącznie przez automatyczny harmonogram (Cloudflare); ten filtr nie ma innych portali do skanowania.";
