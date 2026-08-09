import type { ComparableListing, MarketListing } from "./types";
import { preferredListingUrl } from "./comparable-url.ts";
import { compareResolvedLocations, resolveDeterministicLocation } from "../location-intelligence/deterministic-location.ts";
import type { LocationResolution } from "../location-intelligence/types.ts";

const TARGET_COMPARABLE_COUNT = 10;

export function selectComparableListings(
  subject: MarketListing,
  candidates: MarketListing[],
  resolvedLocations: ReadonlyMap<string, LocationResolution> = new Map(),
): ComparableListing[] {
  const selected = new Map<string, ComparableListing>();
  const subjectLocation = listingLocation(subject, resolvedLocations);

  const tiers: Array<{ name: string; matches: (listing: MarketListing) => boolean }> = [
    {
      name: "ta sama ulica",
      matches: (listing) => compareResolvedLocations(subjectLocation, listingLocation(listing, resolvedLocations)).streetMatch && similarArea(subject, listing) && similarRooms(subject, listing),
    },
    {
      name: "to samo osiedle",
      matches: (listing) => compareResolvedLocations(subjectLocation, listingLocation(listing, resolvedLocations)).neighborhoodMatch && similarArea(subject, listing) && similarRooms(subject, listing),
    },
    {
      name: "ta sama dzielnica",
      matches: (listing) => compareResolvedLocations(subjectLocation, listingLocation(listing, resolvedLocations)).districtMatch && similarArea(subject, listing) && similarRooms(subject, listing),
    },
    {
      name: "to samo miasto",
      matches: (listing) => compareResolvedLocations(subjectLocation, listingLocation(listing, resolvedLocations)).cityMatch && similarArea(subject, listing) && similarRooms(subject, listing),
    },
    {
      name: "rozszerzony obszar miasta",
      matches: (listing) => compareResolvedLocations(subjectLocation, listingLocation(listing, resolvedLocations)).cityMatch && relaxedArea(subject, listing),
    },
  ];

  for (const tier of tiers) {
    for (const listing of candidates) {
      if (selected.size >= TARGET_COMPARABLE_COUNT || listing.id === subject.id || !tier.matches(listing) || selected.has(listing.id)) continue;
      const comparable = toComparable(subject, listing, tier.name);
      selected.set(comparable.id, comparable);
    }
    if (selected.size >= TARGET_COMPARABLE_COUNT) break;
  }

  const comparables = [...selected.values()].sort((left, right) => right.similarityScore - left.similarityScore);
  if (process.env.NODE_ENV === "development") {
    for (const comparable of comparables.slice(0, 10)) {
      const target = listingLocation(subject, resolvedLocations);
      const candidate = listingLocation(candidates.find((listing) => listing.id === comparable.id) ?? subject, resolvedLocations);
      console.info("MARKET LOCATION DIAGNOSTIC", JSON.stringify({
        target: { street: target.street, neighborhood: target.neighborhood, district: target.district, city: target.city },
        comparable: { listingId: comparable.id, street: candidate.street, neighborhood: candidate.neighborhood, district: candidate.district, city: candidate.city },
        matches: compareResolvedLocations(target, candidate),
        similarityScore: comparable.similarityScore,
      }));
    }
  }
  return comparables;
}

export function streetKey(address: string | null, district: string | null = null, city: string | null = null): string | null {
  if (!address) return null;
  const excluded = new Set([locationKey(district), locationKey(city)].filter((value): value is string => value !== null));
  const parts = address.split(",").map(locationKey).filter((value): value is string => value !== null && !excluded.has(value));
  if (!parts.length) return null;
  return parts.join(" ").replace(/^(?:ulica|ul|aleja|al|plac|pl)\s+/u, "").replace(/\b\d+[\p{L}\d/-]*\b/gu, "").replace(/\s+/g, " ").trim() || null;
}

export function compareLocations(subject: Pick<MarketListing, "address" | "district" | "city">, comparable: Pick<MarketListing, "address" | "district" | "city">) {
  const targetStreet = streetKey(subject.address, subject.district, subject.city);
  const comparableStreet = streetKey(comparable.address, comparable.district, comparable.city);
  const targetDistrict = locationKey(subject.district);
  const comparableDistrict = locationKey(comparable.district);
  return {
    targetStreet,
    comparableStreet,
    streetMatch: Boolean(targetStreet && comparableStreet && targetStreet === comparableStreet),
    targetDistrict,
    comparableDistrict,
    districtMatch: Boolean(targetDistrict && comparableDistrict && targetDistrict === comparableDistrict),
  };
}

function toComparable(subject: MarketListing, listing: MarketListing, tier: string): ComparableListing {
  const reasons = [tier];
  const scoring = tierScoring(tier);
  let similarityScore = scoring.base;
  const areaDifference = difference(subject.area, listing.area);

  if (areaDifference !== null) {
    similarityScore += Math.max(0, 12 - areaDifference);
    reasons.push(`metraż różni się o ${formatNumber(areaDifference)} m²`);
  }
  if (similarRooms(subject, listing)) {
    similarityScore += 6;
    reasons.push("podobna liczba pokoi");
  }
  if (sameMarket(subject, listing)) {
    similarityScore += 4;
    reasons.push("ten sam rynek");
  }

  return {
    id: listing.id,
    title: listing.title,
    originalUrl: preferredListingUrl(listing.originalUrl, listing.normalizedUrl, listing.source, listing.id, true),
    normalizedUrl: listing.normalizedUrl,
    price: listing.price,
    area: listing.area,
    pricePerSqm: listing.pricePerSqm,
    rooms: listing.rooms,
    address: listing.address,
    district: listing.district,
    city: listing.city,
    source: listing.source,
    lastSeenAt: listing.lastSeenAt,
    similarityScore: Math.min(scoring.max, Math.round(similarityScore)),
    matchReasons: reasons,
  };
}

function tierScoring(tier: string): { base: number; max: number } {
  if (tier === "ta sama ulica") return { base: 90, max: 100 };
  if (tier === "to samo osiedle") return { base: 70, max: 89 };
  if (tier === "ta sama dzielnica") return { base: 45, max: 69 };
  if (tier === "to samo miasto") return { base: 20, max: 44 };
  return { base: 10, max: 19 };
}

function listingLocation(listing: MarketListing, resolvedLocations: ReadonlyMap<string, LocationResolution>): LocationResolution {
  return resolvedLocations.get(listing.id) ?? resolveDeterministicLocation({
    address: listing.address,
    street: null,
    district: listing.district,
    city: listing.city,
    locationText: [listing.address, listing.district, listing.city].filter(Boolean).join(", ") || null,
    title: listing.title,
    description: listing.description,
  });
}

function similarArea(subject: MarketListing, listing: MarketListing): boolean {
  const areaDifference = difference(subject.area, listing.area);
  return areaDifference === null || areaDifference <= 10;
}

function relaxedArea(subject: MarketListing, listing: MarketListing): boolean {
  const areaDifference = difference(subject.area, listing.area);
  return areaDifference === null || areaDifference <= 20;
}

function similarRooms(subject: MarketListing, listing: MarketListing): boolean {
  return subject.rooms === null || listing.rooms === null || Math.abs(subject.rooms - listing.rooms) <= 1;
}

function sameMarket(subject: MarketListing, listing: MarketListing): boolean {
  return subject.marketTypes.some((marketType) => listing.marketTypes.includes(marketType));
}

function difference(left: number | null, right: number | null): number | null {
  return isPositiveFinite(left) && isPositiveFinite(right) ? Math.abs(left - right) : null;
}

function locationKey(value: string | null): string | null {
  return value?.normalize("NFC").trim().toLocaleLowerCase("pl-PL").replace(/[,.;:]+/g, " ").replace(/\s+/g, " ").trim() || null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 }).format(value);
}

function isPositiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
