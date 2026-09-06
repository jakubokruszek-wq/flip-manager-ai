import { isAllowedFacebookCdnHost, type FacebookImageMirrorResult } from "./mirror-facebook-images-core.ts";

/**
 * Image work is deliberately explicit. SEARCH is data-first and must not
 * spend network/storage budget mirroring a gallery; manual imports keep the
 * historical full-mirror behaviour.
 */
export type FacebookImageMode = "SEARCH_DATA_FIRST" | "FULL";

export function dataFirstFacebookImageResult(
  existingImages: readonly string[],
  incomingImageCount: number,
): FacebookImageMirrorResult {
  const images = [...new Set(existingImages.filter(isStableStoredImage))];
  return {
    images,
    warnings: [],
    stats: {
      // Keep the number of exact candidates observable while making it clear
      // that no storage upload was attempted by this SEARCH import.
      inputCount: Math.max(0, Math.floor(incomingImageCount)),
      uploadedCount: 0,
      skippedCount: Math.max(0, Math.floor(incomingImageCount)),
      failedCount: 0,
    },
  };
}

function isStableStoredImage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isAllowedFacebookCdnHost(url.hostname);
  } catch {
    return false;
  }
}
