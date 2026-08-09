import "server-only";

import { isAllowedFacebookCdnHost, mirrorFacebookImageUrls, type FacebookImageMirrorResult } from "../mirror-facebook-images-core";
import { createFacebookWatcherAdminClient } from "../supabase-admin";
import { ensureFacebookImageBucket, FACEBOOK_IMAGE_BUCKET } from "./facebook-image-storage";

export async function mirrorFacebookImages(input: {
  listingId: string;
  imageUrls: string[];
  existingImages?: string[];
}): Promise<FacebookImageMirrorResult> {
  const supabase = createFacebookWatcherAdminClient();
  try {
    await ensureFacebookImageBucket(supabase);
    const result = await mirrorFacebookImageUrls(input.listingId, input.imageUrls, {
      existingImages: input.existingImages,
      storageOrigin: process.env.NEXT_PUBLIC_SUPABASE_URL,
      upload: async ({ bytes, contentType, path }) => {
        const uploaded = await supabase.storage.from(FACEBOOK_IMAGE_BUCKET).upload(path, bytes, { contentType, upsert: false });
        if (uploaded.error && !isDuplicateObjectError(uploaded.error)) throw uploaded.error;
        return {
          publicUrl: supabase.storage.from(FACEBOOK_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl,
          uploaded: !uploaded.error,
        };
      },
    });
    developmentSummary(input.listingId, result);
    for (const warning of result.warnings) developmentError(warning);
    return result;
  } catch (error) {
    const existingImages = (input.existingImages ?? []).filter(isStableHttpsUrl);
    const result: FacebookImageMirrorResult = {
      images: existingImages,
      warnings: [error instanceof Error ? error.message : "Nie udało się uruchomić mirroringu obrazów."],
      stats: { inputCount: input.imageUrls.length, uploadedCount: 0, skippedCount: 0, failedCount: input.imageUrls.length },
    };
    developmentSummary(input.listingId, result);
    developmentError(result.warnings[0]);
    return result;
  }
}

function isDuplicateObjectError(error: { message?: string; statusCode?: string | number }): boolean {
  return Number(error.statusCode) === 409 || /duplicate|already exists/i.test(error.message ?? "");
}

function isStableHttpsUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !isAllowedFacebookCdnHost(url.hostname); }
  catch { return false; }
}

function developmentSummary(listingId: string, result: FacebookImageMirrorResult): void {
  if (process.env.NODE_ENV !== "development") return;
  console.info("FACEBOOK IMAGE MIRROR", { listingId, ...result.stats });
}

function developmentError(reason: string): void {
  if (process.env.NODE_ENV !== "development") return;
  const host = reason.match(/(?:z|źródło obrazu:) ([^: .]+(?:\.[^: .]+)+)/i)?.[1] ?? "unknown";
  const status = Number(reason.match(/HTTP (\d{3})/)?.[1]) || null;
  console.error("FACEBOOK IMAGE MIRROR ERROR", { urlHost: host, status, reason });
}
