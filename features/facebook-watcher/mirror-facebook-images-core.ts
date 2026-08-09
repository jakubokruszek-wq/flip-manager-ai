import { createHash } from "node:crypto";

export const FACEBOOK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FACEBOOK_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

type SupportedMimeType = (typeof FACEBOOK_IMAGE_MIME_TYPES)[number];

export type FacebookImageMirrorStats = {
  inputCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
};

export type FacebookImageMirrorResult = {
  images: string[];
  warnings: string[];
  stats: FacebookImageMirrorStats;
};

type UploadImage = (input: {
  bytes: Uint8Array;
  contentType: SupportedMimeType;
  path: string;
}) => Promise<{ publicUrl: string; uploaded: boolean }>;

type MirrorOptions = {
  existingImages?: string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  storageOrigin?: string;
  timeoutMs?: number;
  upload: UploadImage;
};

export async function mirrorFacebookImageUrls(
  listingId: string,
  inputUrls: string[],
  options: MirrorOptions,
): Promise<FacebookImageMirrorResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? FACEBOOK_IMAGE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const stats: FacebookImageMirrorStats = { inputCount: inputUrls.length, uploadedCount: 0, skippedCount: 0, failedCount: 0 };
  const warnings: string[] = [];
  const output = uniqueStableExistingImages(options.existingImages ?? []);
  const outputSet = new Set(output);
  const seenInputs = new Set<string>();

  for (const rawUrl of inputUrls) {
    const value = rawUrl.trim();
    if (!value || seenInputs.has(value)) {
      stats.skippedCount += 1;
      continue;
    }
    seenInputs.add(value);

    if (isFacebookWatcherStorageUrl(value, options.storageOrigin)) {
      if (!outputSet.has(value)) {
        output.push(value);
        outputSet.add(value);
      } else {
        stats.skippedCount += 1;
      }
      continue;
    }

    let sourceUrl: URL;
    try {
      sourceUrl = new URL(value);
    } catch {
      stats.skippedCount += 1;
      warnings.push("Pominięto nieprawidłowy adres zdjęcia Facebooka.");
      continue;
    }
    if (sourceUrl.protocol !== "https:" || !isAllowedFacebookCdnHost(sourceUrl.hostname)) {
      stats.skippedCount += 1;
      warnings.push(`Pominięto niedozwolone źródło obrazu: ${sourceUrl.hostname || "brak hosta"}.`);
      continue;
    }

    try {
      const response = await fetchWithSafeRedirects(sourceUrl, fetchImpl, timeoutMs);
      if (!response.ok) throw new MirrorImageError(`HTTP ${response.status}`, response.status);
      const contentType = normalizedMimeType(response.headers.get("content-type"));
      if (!contentType) throw new MirrorImageError("Nieobsługiwany typ obrazu");
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new MirrorImageError("Obraz przekracza limit 10 MB");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new MirrorImageError("Obraz przekracza limit 10 MB");
      if (bytes.byteLength === 0) throw new MirrorImageError("Pusty obraz");
      if (!matchesImageSignature(bytes, contentType)) throw new MirrorImageError("Zawartość nie odpowiada typowi obrazu");

      const hash = createHash("sha256").update(bytes).digest("hex");
      const path = `facebook/${safePathSegment(listingId)}/${hash}.${extensionFor(contentType)}`;
      const stored = await options.upload({ bytes, contentType, path });
      if (!outputSet.has(stored.publicUrl)) {
        output.push(stored.publicUrl);
        outputSet.add(stored.publicUrl);
      }
      if (stored.uploaded) stats.uploadedCount += 1;
      else stats.skippedCount += 1;
    } catch (error) {
      stats.failedCount += 1;
      const reason = error instanceof Error ? error.message : "Nieznany błąd obrazu";
      warnings.push(`Nie udało się skopiować obrazu z ${sourceUrl.hostname}: ${reason}.`);
    }
  }

  return { images: output, warnings, stats };
}

export function isAllowedFacebookCdnHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("scontent") && normalized.endsWith(".fbcdn.net");
}

export function isFacebookWatcherStorageUrl(value: string, expectedOrigin?: string): boolean {
  try {
    const url = new URL(value);
    const originMatches = expectedOrigin ? url.origin === new URL(expectedOrigin).origin : /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname);
    return url.protocol === "https:" && originMatches && url.pathname.includes("/storage/v1/object/public/facebook-watcher-images/");
  } catch {
    return false;
  }
}

function uniqueStableExistingImages(values: string[]): string[] {
  return [...new Set(values.filter((value) => isStableExistingImage(value)))];
}

function isStableExistingImage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isAllowedFacebookCdnHost(url.hostname);
  } catch {
    return false;
  }
}

async function fetchWithSafeRedirects(initialUrl: URL, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (currentUrl.protocol !== "https:" || !isAllowedFacebookCdnHost(currentUrl.hostname)) throw new MirrorImageError("Niedozwolony redirect obrazu");
    const response = await fetchImpl(currentUrl, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg", "User-Agent": "FlipManager-FacebookImageMirror/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new MirrorImageError("Redirect bez nagłówka Location", response.status);
    currentUrl = new URL(location, currentUrl);
  }
  throw new MirrorImageError("Zbyt wiele redirectów");
}

function normalizedMimeType(value: string | null): SupportedMimeType | null {
  const mime = value?.split(";", 1)[0].trim().toLowerCase();
  return FACEBOOK_IMAGE_MIME_TYPES.find((allowed) => allowed === mime) ?? null;
}

function extensionFor(contentType: SupportedMimeType): "jpg" | "png" | "webp" {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

function matchesImageSignature(bytes: Uint8Array, contentType: SupportedMimeType): boolean {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  return bytes.length >= 12 && textAt(bytes, 0, 4) === "RIFF" && textAt(bytes, 8, 12) === "WEBP";
}

function textAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

class MirrorImageError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
