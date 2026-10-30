import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { createMobilePost } from "@/features/collector/facebook-mobile";
import { importFacebookCollectorPayload } from "@/features/collector/facebook-import";
import { isEnabledWatchedFacebookSource } from "@/features/facebook-groups/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureFacebookImageBucket, FACEBOOK_IMAGE_BUCKET } from "@/features/facebook-watcher/server/facebook-image-storage";

export const runtime = "nodejs";
export const POST = createMobilePost({
  authenticate: authenticateCollectorDevice,
  allowed: group => isEnabledWatchedFacebookSource({ sourceId: group, type: "GROUP", url: `https://www.facebook.com/groups/${group}/` }),
  authStatus: error => error instanceof CollectorAuthError ? error.status : null,
  upload: async (device, post) => {
    if (!post.photos.length) return [];
    const db = createAdminClient();
    await ensureFacebookImageBucket(db);
    const urls: string[] = [];
    for (const photo of post.photos) {
      // The same bytes always address the same object, even after a lost HTTP response.
      const path = `android/${device}/${post.postId}/${photo.hash}.jpg`;
      const result = await db.storage.from(FACEBOOK_IMAGE_BUCKET).upload(path, photo.bytes, { contentType: "image/jpeg", upsert: true });
      if (result.error) throw new Error("MOBILE_PHOTO_RETRY");
      urls.push(db.storage.from(FACEBOOK_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl);
    }
    return urls;
  },
  importPost: async (device, key, post, images) => {
    const result = await importFacebookCollectorPayload(device, key, {
      sourcePostUrl: post.permalink, title: "Oferta z Facebooka", content: null,
      price: post.price, area: post.area, rooms: post.rooms, location: post.location,
      imageUrls: images, publishedAt: null, authorName: null, groupName: null,
    }, { mobileSnapshot: true });
    return { listingId: result.listingId, status: result.status };
  },
});
