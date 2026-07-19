import type { PropertyImporterAdapter } from "./property-importer-adapter";
import { mapOtodomListing, parseOtodomListing } from "../parsers/otodom.parser";
import { fetchListingHtml } from "../services/fetch-listing-html";
import type { ImportedProperty } from "../types";

export class OtodomAdapter implements PropertyImporterAdapter {
  supports(url: string): boolean {
    try {
      return isOtodomUrl(new URL(url));
    } catch {
      return false;
    }
  }

  async import(url: string): Promise<ImportedProperty> {
    const { html, url: resolvedUrl } = await fetchListingHtml(new URL(url), {
      allowsUrl: isOtodomUrl,
    });
    console.log("OTODOM HTML LENGTH:", html.length);

    const parsed = parseOtodomListing(html);
    console.log("OTODOM PARSER RESULT:", parsed);

    const property = mapOtodomListing(parsed, resolvedUrl);
    console.log("OTODOM IMPORTED PROPERTY:", property);

    return property;
  }
}

function isOtodomUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "otodom.pl" || url.hostname.endsWith(".otodom.pl"))
  );
}
