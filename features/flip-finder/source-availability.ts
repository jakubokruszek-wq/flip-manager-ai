import type { ListingSource } from "@/features/flip-finder";

/** Source IDs whose complete local adapter path is approved for Finder scans. */
export const SCHEMA_READY_SOURCE_IDS = [
  "otodom",
  "olx",
  "morizon",
  "domiporta",
  "sprzedajemy",
  "adresowo",
  "gratka",
] as const satisfies readonly Exclude<ListingSource, "facebook">[];

export type SchemaReadySourceId = (typeof SCHEMA_READY_SOURCE_IDS)[number];

/** Facebook is readable by Finder, but acquired only by the independent Watcher. */
export function isActiveFilterSource(source: ListingSource): boolean {
  return source === "facebook" || SCHEMA_READY_SOURCE_IDS.includes(source as SchemaReadySourceId);
}

/** Remove legacy/unavailable IDs before displaying active source controls. */
export function activeFilterSources(sources: readonly ListingSource[]): ListingSource[] {
  return sources.filter(isActiveFilterSource);
}
