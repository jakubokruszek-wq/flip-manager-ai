import type { PropertySourceListing } from "../../../features/properties/types/property.ts";

/**
 * Corrections applied by the cloud worker on top of the unchanged Finder
 * parser output (inside the page, so they cost no Worker CPU). `rawPayload`
 * and `contentHash` are left exactly as the parser produced them.
 *
 * 1. Stable listing id. The Finder parser reads `ad.id` only when it is a
 *    string; OLX serves it as a number, so the parser falls back to the last
 *    URL segment, i.e. the title slug ("mieszkanie-2-pokoje-…-ID13Ab.html").
 *    Editing the title changes the slug, hence the id, and the same flat is
 *    stored again. The stable id is OLX's own numeric `ad.id`; when absent,
 *    the "ID…" token of the URL (independent of the slug) is used.
 *
 * 2. Image URLs. OLX photo links are templates
 *    (`…/image;s={width}x{height}`); the parser keeps the placeholder,
 *    URL-encoded (`%7Bwidth%7Dx%7Bheight%7D`), which the CDN cannot serve.
 *    The placeholder is replaced with the photo's own dimensions from the
 *    same ad (or a 1000x750 default).
 */

export type ListingIdMode = "stable" | "legacy";

export type ListingFixOptions = { idMode: ListingIdMode };

export type ListingFixReport = { stableIds: number; legacyIdsKept: number; imagesResolved: number; imagesUnresolved: number };

const TEMPLATE = /(?:\{|%7B)width(?:\}|%7D)x(?:\{|%7B)height(?:\}|%7D)/i;
const TEMPLATE_GLOBAL = /(?:\{|%7B)width(?:\}|%7D)x(?:\{|%7B)height(?:\}|%7D)/gi;
export const DEFAULT_IMAGE_SIZE = "1000x750";
const MAX_DIMENSION = 4000;

export function stableOlxId(ad: Record<string, unknown>): string | null {
  const id = ad.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  // A string id is what the Finder parser already uses: keep it identical.
  if (typeof id === "string" && id.trim()) return id.trim();
  const url = typeof ad.url === "string" ? ad.url : "";
  const token = url.match(/-ID([A-Za-z0-9]+)\.html(?:[?#]|$)/);
  return token ? `ID${token[1]}` : null;
}

export function applyListingFixes(listings: PropertySourceListing[], options: ListingFixOptions): ListingFixReport {
  const report: ListingFixReport = { stableIds: 0, legacyIdsKept: 0, imagesResolved: 0, imagesUnresolved: 0 };
  for (const listing of listings) {
    const raw = listing.rawPayload ?? {};
    if (options.idMode === "stable") {
      const stable = stableOlxId(raw);
      if (stable) {
        listing.externalListingId = stable;
        report.stableIds += 1;
      } else {
        report.legacyIdsKept += 1;
      }
    }
    const sizes = photoSizes(raw.photos);
    const resolve = (url: string): string => {
      if (!TEMPLATE.test(url)) return url;
      const size = sizes.get(photoFileId(url) ?? "") ?? DEFAULT_IMAGE_SIZE;
      const fixed = url.replace(TEMPLATE_GLOBAL, size);
      if (TEMPLATE.test(fixed)) report.imagesUnresolved += 1; else report.imagesResolved += 1;
      return fixed;
    };
    if (Array.isArray(listing.images)) listing.images = listing.images.map(resolve);
    if (typeof listing.thumbnailUrl === "string") listing.thumbnailUrl = listing.images?.[0] ?? resolve(listing.thumbnailUrl);
  }
  return report;
}

/** Apollo file id ("…/v1/files/<id>/image…") → "WxH" from the ad's photo list. */
function photoSizes(photos: unknown): Map<string, string> {
  const sizes = new Map<string, string>();
  if (!Array.isArray(photos)) return sizes;
  for (const photo of photos) {
    if (!photo || typeof photo !== "object") continue;
    const record = photo as Record<string, unknown>;
    const link = typeof record.link === "string" ? record.link : null;
    const width = Number(record.width);
    const height = Number(record.height);
    const id = link ? photoFileId(link) : null;
    if (id && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
      sizes.set(id, `${width}x${height}`);
    }
  }
  return sizes;
}

function photoFileId(url: string): string | null {
  return url.match(/\/files\/([^/;?#]+)\//)?.[1] ?? null;
}
