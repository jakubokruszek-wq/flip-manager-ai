import { verifyMobileJpeg } from "@/features/collector/mobile-jpeg";
import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { createMobilePost } from "@/features/collector/facebook-mobile";
import { importFacebookCollectorPayload } from "@/features/collector/facebook-import";
import { isEnabledWatchedFacebookSource, listWatchedFacebookGroups } from "@/features/facebook-groups/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureFacebookImageBucket, FACEBOOK_IMAGE_BUCKET } from "@/features/facebook-watcher/server/facebook-image-storage";

export const runtime = "nodejs";
export const POST = createMobilePost({
  authenticate: authenticateCollectorDevice,
  allowed: (sourceId, type = "GROUP") => isEnabledWatchedFacebookSource({ sourceId, type, url: type === "GROUP" ? `https://www.facebook.com/groups/${sourceId}/` : `https://www.facebook.com/profile.php?id=${sourceId}` }),
  removed: async post => {
    const result=await createAdminClient().from("facebook_watcher_removed_posts").select("post_id").eq("post_id",post.postId).maybeSingle();
    if(result.error)throw new Error("MOBILE_REMOVAL_CHECK_RETRY");
    return Boolean(result.data);
  },
  authStatus: error => error instanceof CollectorAuthError ? error.status : null,
  upload: async (device, post) => {
    if (!post.photos.length) return [];
    for (const photo of post.photos) await verifyMobileJpeg(photo.bytes);
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
    const profile = post.sourceType === "PROFILE" ? (await listWatchedFacebookGroups()).find(source => source.enabled && source.type === "PROFILE" && source.sourceId === post.groupId) : null;
    if (post.sourceType === "PROFILE" && !profile) throw new Error("MOBILE_SOURCE_DISABLED");
    const result = await importFacebookCollectorPayload(device, key, {
      sourcePostUrl: post.permalink, title: "Oferta z Facebooka", content: post.postText,
      price: post.price, area: post.area, rooms: post.rooms, location: post.location,
      imageUrls: images, publishedAt: null, authorName: profile?.name ?? null, groupName: profile ? `Profil: ${profile.name}` : null,
    }, { mobileSnapshot: true, mobileSaleConfirmed: true });
    return { listingId: result.listingId, status: result.status };
  },
});
