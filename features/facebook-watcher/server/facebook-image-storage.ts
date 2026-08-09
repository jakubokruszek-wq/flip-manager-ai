import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { FACEBOOK_IMAGE_MAX_BYTES, FACEBOOK_IMAGE_MIME_TYPES } from "../mirror-facebook-images-core";

export const FACEBOOK_IMAGE_BUCKET = "facebook-watcher-images";

export async function ensureFacebookImageBucket(supabase: SupabaseClient): Promise<void> {
  const buckets = await supabase.storage.listBuckets();
  if (buckets.error) throw buckets.error;
  if (buckets.data.some((bucket) => bucket.name === FACEBOOK_IMAGE_BUCKET)) {
    const updated = await supabase.storage.updateBucket(FACEBOOK_IMAGE_BUCKET, {
      public: true,
      fileSizeLimit: FACEBOOK_IMAGE_MAX_BYTES,
      allowedMimeTypes: [...FACEBOOK_IMAGE_MIME_TYPES],
    });
    if (updated.error) throw updated.error;
    return;
  }
  const created = await supabase.storage.createBucket(FACEBOOK_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: FACEBOOK_IMAGE_MAX_BYTES,
    allowedMimeTypes: [...FACEBOOK_IMAGE_MIME_TYPES],
  });
  if (created.error) throw created.error;
}
