import { createHash } from "node:crypto";
import type {
  FacebookCollectorPropertyPayload,
  NormalizedFacebookPropertyImport,
} from "@/features/properties/types/property";

export type FacebookCollectorPayload = FacebookCollectorPropertyPayload;
export type NormalizedFacebookImport = NormalizedFacebookPropertyImport;

const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"]);

export function normalizeFacebookCollectorPayload(value: unknown): NormalizedFacebookImport {
  if (!isRecord(value)) {
    throw new Error("Nieprawidłowe dane importu Facebooka.");
  }

  const normalizedPostUrl = normalizeFacebookPostUrl(requiredString(value.sourcePostUrl, "Link posta"));
  const price = nullableNonnegativeNumber(value.price, "Cena");
  const area = nullablePositiveNumber(value.area, "Powierzchnia");
  const rooms = nullablePositiveNumber(value.rooms, "Liczba pokoi");
  const imageUrls = uniqueHttpsUrls(value.imageUrls);
  const collectedAt = nullableIsoDate(value.collectedAt) ?? new Date().toISOString();

  const payload: FacebookCollectorPayload = {
    sourcePostUrl: normalizedPostUrl,
    title: nullableString(value.title),
    groupName: nullableString(value.groupName),
    authorName: nullableString(value.authorName),
    publishedAt: nullableIsoDate(value.publishedAt),
    content: nullableString(value.content),
    price,
    area,
    rooms,
    location: nullableString(value.location),
    imageUrls,
    collectedAt,
  };
  const externalListingId = facebookExternalListingId(normalizedPostUrl);
  const contentHash = sha256(
    JSON.stringify({
      groupName: payload.groupName,
      authorName: payload.authorName,
      content: payload.content,
      imageUrls: [...payload.imageUrls].sort(),
    }),
  );

  return {
    ...payload,
    normalizedPostUrl,
    externalListingId,
    contentHash,
    pricePerSqm: price !== null && area !== null ? price / area : null,
  };
}

export function facebookExternalListingId(normalizedPostUrl: string): string {
  const url = new URL(normalizedPostUrl);
  const groupPost = /^\/groups\/([^/]+)\/posts\/([^/]+)$/i.exec(url.pathname);
  if (groupPost) return `facebook:group:${groupPost[1]}:post:${groupPost[2]}`;
  const story = url.searchParams.get("story_fbid");
  const owner = url.searchParams.get("id");
  if (story && owner) return `facebook:story:${owner}:${story}`;
  return `facebook:url:${sha256(normalizedPostUrl)}`;
}

export function normalizeFacebookPostUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Link posta Facebooka musi być poprawnym adresem HTTPS.");
  }

  if (url.protocol !== "https:" || !FACEBOOK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Link posta musi prowadzić do Facebooka przez HTTPS.");
  }

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "ref" || key === "mibextid") {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";

  return url.toString();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  const text = nullableString(value);
  if (!text) {
    throw new Error(`${field} jest wymagany.`);
  }

  return text;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNonnegativeNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} musi być nieujemną liczbą.`);
  }

  return parsed;
}

function nullablePositiveNumber(value: unknown, field: string): number | null {
  const parsed = nullableNonnegativeNumber(value, field);
  if (parsed !== null && parsed <= 0) {
    throw new Error(`${field} musi być dodatnią liczbą.`);
  }

  return parsed;
}

function nullableIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Data ma nieprawidłowy format.");
  }

  return new Date(value).toISOString();
}

function uniqueHttpsUrls(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("Zdjęcia muszą być tablicą adresów URL.");
  }

  const urls = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      continue;
    }

    try {
      const url = new URL(item);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
        urls.add(url.toString());
      }
    } catch {
      continue;
    }
  }

  return [...urls].slice(0, 10);
}
