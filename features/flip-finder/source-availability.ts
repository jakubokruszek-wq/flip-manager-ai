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
  "nieruchomosci_online",
  "oferty_net",
  "domy",
  "allegro_lokalnie",
  "official_cooperative",
  "official_uml",
] as const satisfies readonly Exclude<ListingSource, "facebook">[];

export type SchemaReadySourceId = (typeof SCHEMA_READY_SOURCE_IDS)[number];

/**
 * Source IDs this app once actively scanned but has deliberately turned off
 * everywhere (Finder, Radar, Watcher, manual runs, continuations,
 * schedules, queues, URL imports). The ID stays a valid, recognized
 * ListingSource -- so historical results, errors, and saved filter/settings
 * entries referencing it remain readable -- it is simply never eligible to
 * be fetched again. Checked separately from "never built at all" so a
 * resumed legacy checkpoint or continuation can report the honest,
 * specific "Źródło wyłączone" instead of a generic not-registered error.
 */
export const DISABLED_SOURCE_IDS = ["szybko"] as const satisfies readonly Exclude<ListingSource, "facebook">[];
export type DisabledSourceId = (typeof DISABLED_SOURCE_IDS)[number];

export function isDisabledSource(source: ListingSource): source is DisabledSourceId {
  return (DISABLED_SOURCE_IDS as readonly ListingSource[]).includes(source);
}

/** Facebook is readable by Finder, but acquired only by the independent Watcher. */
export function isActiveFilterSource(source: ListingSource): boolean {
  return source === "facebook" || SCHEMA_READY_SOURCE_IDS.includes(source as SchemaReadySourceId);
}

/** Remove legacy/unavailable IDs before displaying active source controls. */
export function activeFilterSources(sources: readonly ListingSource[]): ListingSource[] {
  return sources.filter(isActiveFilterSource);
}
