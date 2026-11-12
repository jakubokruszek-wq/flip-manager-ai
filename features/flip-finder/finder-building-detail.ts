import type { PropertySourceListing } from "@/features/properties/types/property";
import { parseRadarOfferDetail } from "./external-source-adapters";
import { calculateContentHash } from "./otodom-search";

export const FINDER_BUILDING_DETAIL_TIMEOUT_MS = 4000;
export function needsFinderBuildingDetail(listing: PropertySourceListing, criteria: { yearBuiltMin?: number | null; buildingTypes: readonly string[] }): boolean {
  return (listing.source === "gratka" || listing.source === "morizon") &&
    ((criteria.yearBuiltMin != null && listing.yearBuilt == null) || (criteria.buildingTypes.length > 0 && !listing.buildingType));
}

function detailIdentity(value: string, source: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (source === "gratka" && ["gratka.pl", "www.gratka.pl"].includes(url.hostname)) return url.pathname.match(/\/ob\/(\d+)\/?$/u)?.[1] ?? null;
    if (source === "morizon" && ["morizon.pl", "www.morizon.pl"].includes(url.hostname)) return url.pathname.match(/(mzn\d+)\/?$/u)?.[1] ?? null;
  } catch { /* untrusted source URL */ }
  return null;
}

/** One bounded own-detail request, within the Finder's existing buffered listing checkpoint. */
export async function enrichFinderBuildingDetail(listing: PropertySourceListing, parent: AbortSignal, timeoutMs = FINDER_BUILDING_DETAIL_TIMEOUT_MS): Promise<PropertySourceListing> {
  const identity = detailIdentity(listing.originalUrl, listing.source);
  if (!identity || (listing.source !== "gratka" && listing.source !== "morizon")) return listing;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  try {
    let url = listing.originalUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { redirect: "manual", cache: "no-store", signal, headers: { Accept: "text/html", "User-Agent": "FlipManager/1.0" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return listing;
        const target = new URL(location, url).toString();
        if (detailIdentity(target, listing.source) !== identity) return listing;
        url = target;continue;
      }
      if (!response.ok || (response.url && detailIdentity(response.url, listing.source) !== identity)) { await response.body?.cancel();return listing; }
      const reader = response.body?.getReader();if (!reader) return listing;
      const chunks: Uint8Array[] = [];let size = 0;
      try {
        while (true) { const item = await reader.read();if (item.done) break;size += item.value.byteLength;
          if (size > 5_000_000) { await reader.cancel();return listing; }chunks.push(item.value); }
      } finally { reader.releaseLock(); }
      const detail = parseRadarOfferDetail(listing.source, Buffer.concat(chunks).toString("utf8"), url);
      if (detail.contradictoryFields.includes("identity")) return listing;
      const yearBuilt = detail.yearBuilt ?? listing.yearBuilt ?? null;
      const buildingType = detail.buildingType ?? listing.buildingType;
      if (yearBuilt === listing.yearBuilt && buildingType === listing.buildingType) return listing;
      return { ...listing, yearBuilt, buildingType,
        rawPayload: { ...listing.rawPayload, finderBuildingDetail: { url, yearBuilt: detail.yearBuilt, buildingType: detail.buildingType } },
        contentHash: calculateContentHash({ previous: listing.contentHash, yearBuilt, buildingType }) };
    }
  } catch { parent.throwIfAborted(); /* inaccessible facts stay unknown, never guessed */ }
  return listing;
}
