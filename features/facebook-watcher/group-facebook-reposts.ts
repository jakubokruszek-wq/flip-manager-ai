import type { FacebookWatcherListing } from "./types";

/** Group the view only. Different post IDs and every source record remain intact. */
export function groupFacebookReposts(records: FacebookWatcherListing[]): FacebookWatcherListing[] {
  const groups: FacebookWatcherListing[] = [];
  for (const item of records) {
    const hashes = mobilePhotoHashes(item.images);
    const target = groups.find(candidate => compatible(candidate, item) && mobilePhotoHashes(candidate.images).some(hash => hashes.includes(hash)));
    if (!target) { groups.push({ ...item }); continue; }
    const publications = [...(target.relatedPosts ?? [publication(target)]), publication(item)];
    // Keep the first result in the requested sort order; never combine photos
    // bound to separate posts or propagate a workflow decision across them.
    target.relatedPosts = publications;
  }
  return groups;
}

function publication(item: FacebookWatcherListing) {
  return { listingId: item.listingId, url: item.sourcePostUrl ?? item.originalUrl, groupName: item.groupName };
}

function compatible(a: FacebookWatcherListing, b: FacebookWatcherListing): boolean {
  if (a.source !== "facebook" || b.source !== "facebook" || !a.price || !a.area || a.price !== b.price || a.area !== b.area) return false;
  if (a.workflowStatus !== b.workflowStatus || a.status !== b.status || a.lifecycleStatus !== b.lifecycleStatus) return false;
  for (const key of ["rooms", "floor", "city", "district", "neighborhood", "street"] as const) {
    if (a[key] !== null && b[key] !== null && a[key] !== b[key]) return false;
  }
  return true;
}

function mobilePhotoHashes(images: string[]): string[] {
  return images.flatMap(value => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return [];
      // Only content-addressed bytes from the application's own uploader;
      // arbitrary CDN filenames and generic image URLs are not evidence.
      const match = /^\/storage\/v1\/object\/public\/facebook-watcher-images\/android\/[0-9a-f-]{36}\/\d{5,30}\/([a-f0-9]{64})\.jpg$/u.exec(url.pathname);
      return match ? [`${url.origin}:${match[1]}`] : [];
    } catch { return []; }
  });
}
