import type { SearchFilter } from "@/features/flip-finder";
import type { PropertySearchListing } from "@/features/properties/types/property";

export const CITY_PATHS: Record<string, string> = {
  "łódź": "lodzkie/lodz/lodz/lodz",
  lodz: "lodzkie/lodz/lodz/lodz",
  warszawa: "mazowieckie/warszawa/warszawa/warszawa",
  "kraków": "malopolskie/krakow/krakow/krakow",
  krakow: "malopolskie/krakow/krakow/krakow",
  "wrocław": "dolnoslaskie/wroclaw/wroclaw/wroclaw",
  wroclaw: "dolnoslaskie/wroclaw/wroclaw/wroclaw",
  "poznań": "wielkopolskie/poznan/poznan/poznan",
  poznan: "wielkopolskie/poznan/poznan/poznan",
  "gdańsk": "pomorskie/gdansk/gdansk/gdansk",
  gdansk: "pomorskie/gdansk/gdansk/gdansk",
  katowice: "slaskie/katowice/katowice/katowice",
  szczecin: "zachodniopomorskie/szczecin/szczecin/szczecin",
  bydgoszcz: "kujawsko-pomorskie/bydgoszcz/bydgoszcz/bydgoszcz",
  lublin: "lubelskie/lublin/lublin/lublin",
  gdynia: "pomorskie/gdynia/gdynia/gdynia",
  "białystok": "podlaskie/bialystok/bialystok/bialystok",
  bialystok: "podlaskie/bialystok/bialystok/bialystok",
};

export const ROOMS_ENUM: Record<number, string> = {
  1: "ONE",
  2: "TWO",
  3: "THREE",
  4: "FOUR",
  5: "FIVE",
  6: "SIX_OR_MORE",
};

export function cityPath(city: string | null): string {
  const normalizedCity = city?.trim().toLocaleLowerCase("pl-PL") ?? "";
  return CITY_PATHS[normalizedCity] ?? "cala-polska";
}

export function roomsParam(rooms: number[]): string[] {
  return [...new Set(rooms)]
    .sort((left, right) => left - right)
    .map((room) => ROOMS_ENUM[room])
    .filter((room): room is string => Boolean(room));
}

export function buildSearchUrl(filter: SearchFilter): string {
  const url = new URL(
    `https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/${cityPath(filter.city)}`,
  );

  if (filter.priceMin !== null) {
    url.searchParams.set("priceMin", String(filter.priceMin));
  }

  if (filter.priceMax !== null) {
    url.searchParams.set("priceMax", String(filter.priceMax));
  }

  if (filter.areaMin !== null) {
    url.searchParams.set("areaMin", String(filter.areaMin));
  }

  if (filter.areaMax !== null) {
    url.searchParams.set("areaMax", String(filter.areaMax));
  }

  const roomValues = roomsParam(filter.rooms);
  if (roomValues.length) {
    url.searchParams.set("roomsNumber", `[${roomValues.join(",")}]`);
  }

  url.searchParams.set("limit", "36");
  url.searchParams.set("viewType", "listing");

  return url.toString();
}

export function normalizeOtodomUrl(value: string): string {
  const url = new URL(value, "https://www.otodom.pl");

  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
  ]) {
    url.searchParams.delete(key);
  }

  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "");
  return url.toString();
}

export function extractOtodomListingId(url: string): string | null {
  return (
    new URL(url, "https://www.otodom.pl").pathname
      .match(/-ID([A-Za-z0-9]+)|\/(\d+)(?:\/|$)/)
      ?.slice(1)
      .find(Boolean) ?? null
  );
}

export function calculateContentHash(value: Record<string, unknown>): string {
  const text = JSON.stringify(value, Object.keys(value).sort());
  let hash = 5381;

  for (const char of text) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }

  return (hash >>> 0).toString(16);
}

export function matchesLocalFilter(
  listing: Pick<PropertySearchListing, "pricePerSqm" | "title" | "locationText">,
  filter: SearchFilter,
): boolean {
  if (
    filter.maxPricePerSqm !== null &&
    (listing.pricePerSqm === null || listing.pricePerSqm > filter.maxPricePerSqm)
  ) {
    return false;
  }

  const text = `${listing.title ?? ""} ${listing.locationText ?? ""}`.toLocaleLowerCase(
    "pl-PL",
  );

  return (
    filter.requiredKeywords.every((word) => text.includes(word.toLocaleLowerCase("pl-PL"))) &&
    !filter.excludedKeywords.some((word) => text.includes(word.toLocaleLowerCase("pl-PL")))
  );
}

export function isPriceDrop(previous: number | null, next: number | null): boolean {
  return previous !== null && next !== null && next < previous;
}

export function needsSnapshot(
  previous: { price: number | null; contentHash: string | null } | null,
  next: { price: number | null; contentHash: string },
): boolean {
  return !previous || previous.price !== next.price || previous.contentHash !== next.contentHash;
}
