import { PropertyImportError } from "../errors";
import type { ImportedProperty } from "../types";

type JsonRecord = Record<string, unknown>;

export type OtodomListing = {
  title: string | null;
  url: string | null;
  description: string | null;
  attributes: JsonRecord;
  target: JsonRecord;
  characteristics: JsonRecord[];
  images: JsonRecord[];
  location: JsonRecord;
};

/** Reads Otodom's embedded offer payload, preferring __NEXT_DATA__. */
export function parseOtodomListing(html: string): OtodomListing {
  const nextData = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );

  if (nextData) {
    try {
      const payload = JSON.parse(nextData[1]) as unknown;
      const props = getRecord(payload, "props");
      const pageProps = getRecord(props, "pageProps");
      const ad = getRecord(pageProps, "ad");

      if (ad) {
        return {
          title: getString(ad, "title"),
          url: getString(ad, "url"),
          description: getString(ad, "description"),
          attributes: getRecord(ad, "attributes") ?? {},
          target: getRecord(ad, "target") ?? {},
          characteristics: getRecordArray(ad, "characteristics"),
          images: getRecordArray(ad, "images"),
          location: getRecord(ad, "location") ?? {},
        };
      }
    } catch (error) {
      throw new PropertyImportError(
        "PARSER_FAILED",
        "Nie udało się odczytać danych oferty Otodom z __NEXT_DATA__.",
        error
      );
    }
  }

  const jsonLdListing = parseJsonLdListing(html);

  if (jsonLdListing) {
    return jsonLdListing;
  }

  throw new PropertyImportError(
    "PARSER_FAILED",
    "Otodom nie zwrócił rozpoznawalnych danych oferty."
  );
}

export function mapOtodomListing(
  listing: OtodomListing,
  fallbackUrl: string
): ImportedProperty {
  const address = getRecord(listing.location, "address");
  const street = getRecord(address, "street");
  const streetName = getString(street, "name");
  const streetNumber = getString(street, "number");
  const reverseGeocoding = getRecord(listing.location, "reverseGeocoding");
  const locations = getRecordArray(reverseGeocoding, "locations");

  return {
    source: "otodom",
    title: listing.title ?? "",
    price: firstNumber(listing.target, "Price") ?? characteristicNumber(listing, "price"),
    area: firstNumber(listing.attributes, "m") ?? firstNumber(listing.target, "Area"),
    rooms:
      firstNumber(listing.attributes, "rooms_num") ??
      firstNumber(listing.target, "Rooms_num"),
    floor: formatFloor(firstString(listing.attributes, "floor_no")),
    buildingType: translateBuildingType(firstString(listing.attributes, "building_type")),
    ownership: translateOwnership(
      firstString(listing.attributes, "building_ownership")
    ),
    rent: firstNumber(listing.target, "Rent") ?? characteristicNumber(listing, "rent"),
    address: [streetName, streetNumber].filter(Boolean).join(" ") || null,
    district: locationName(locations, "district"),
    city: locationName(locations, "city_or_village"),
    description: listing.description ? stripHtml(listing.description) : null,
    images: listing.images
      .map(
        (image) =>
          getString(image, "large") ??
          getString(image, "medium") ??
          getString(image, "small") ??
          getString(image, "thumbnail")
      )
      .filter((image): image is string => Boolean(image)),
    originalUrl: listing.url ?? fallbackUrl,
  };
}

function parseJsonLdListing(html: string): OtodomListing | null {
  const scripts = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const script of scripts) {
    try {
      const value = JSON.parse(script[1]) as unknown;
      const node = jsonLdNodes(value).find((candidate) =>
        ["product", "apartment", "offer"].some((type) =>
          getString(candidate, "@type")?.toLowerCase().includes(type)
        )
      );

      if (!node) {
        continue;
      }

      const address = getRecord(node, "address") ?? {};
      const offers = getRecord(node, "offers") ?? {};
      const imageValues = Array.isArray(node.image)
        ? node.image
        : node.image
          ? [node.image]
          : [];

      return {
        title: getString(node, "name") ?? getString(node, "headline"),
        url: getString(node, "url"),
        description: getString(node, "description"),
        attributes: {},
        target: { Price: offers.price ?? node.price },
        characteristics: [],
        images: imageValues
          .map((image) => (typeof image === "string" ? { large: image } : image))
          .filter((image): image is JsonRecord => isRecord(image)),
        location: {
          address: { street: { name: getString(address, "streetAddress") } },
          reverseGeocoding: {
            locations: [
              {
                locationLevel: "city_or_village",
                name: getString(address, "addressLocality"),
              },
            ],
          },
        },
      };
    } catch {
      // Try the next JSON-LD payload when this one is not valid JSON.
    }
  }

  return null;
}

function jsonLdNodes(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  return Array.isArray(value["@graph"])
    ? value["@graph"].filter(isRecord)
    : [value];
}

function getRecord(value: unknown, key: string): JsonRecord | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function getRecordArray(value: unknown, key: string): JsonRecord[] {
  return isRecord(value) && Array.isArray(value[key])
    ? value[key].filter(isRecord)
    : [];
}

function getString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim()
    ? value[key].trim()
    : null;
}

function firstString(value: JsonRecord, key: string): string | null {
  const candidate = Array.isArray(value[key]) ? value[key][0] : value[key];
  return typeof candidate === "string" ? candidate : null;
}

function firstNumber(value: JsonRecord, key: string): number | null {
  const candidate = Array.isArray(value[key]) ? value[key][0] : value[key];
  return toNumber(candidate);
}

function characteristicNumber(listing: OtodomListing, key: string): number | null {
  const characteristic = listing.characteristics.find(
    (item) => getString(item, "key") === key
  );
  return characteristic ? toNumber(characteristic.value) : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function formatFloor(value: string | null): string | null {
  if (!value) return null;
  if (value === "ground_floor") return "parter";
  return value.replace(/^floor_/, "").replace(/_/g, " ");
}

function translateBuildingType(value: string | null): string | null {
  return value
    ? ({ block: "blok", apartment_building: "apartamentowiec" }[value] ?? value)
    : null;
}

function translateOwnership(value: string | null): string | null {
  return value ? ({ full_ownership: "pełna własność" }[value] ?? value) : null;
}

function locationName(locations: JsonRecord[], level: string): string | null {
  const location = locations.find(
    (item) => getString(item, "locationLevel") === level
  );
  return location ? getString(location, "name") : null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
