import type { FacebookWatcherListing } from "./types";

/** Group the view only. Different post IDs and every source record remain intact. */
export function groupFacebookReposts(records: FacebookWatcherListing[]): FacebookWatcherListing[] {
  const groups: FacebookWatcherListing[] = [];
  const members = new Map<FacebookWatcherListing, FacebookWatcherListing[]>();
  // Candidate lookup by exact price and area avoids comparing every post with every other post.
  const buckets = new Map<string, FacebookWatcherListing[]>();
  const imageBuckets = new Map<string, FacebookWatcherListing[]>();
  for (const item of records) {
    const bucketKey = `${item.source}:${item.price ?? "?"}:${item.area ?? "?"}`;
    const candidates = [...new Set([...(buckets.get(bucketKey) ?? []), ...mobilePhotoHashes(item.images).flatMap(hash => imageBuckets.get(hash) ?? [])])];
    const target = candidates.find(candidate => {
      const previous = members.get(candidate)!;
      return previous.every(member => compatible(member,item) || compatibleUnpicturedMember(member,item)) && previous.some(member => (compatible(member,item) && (sameEvidence(member,item) || possibleRepost(member,item))));
    });
    if (!target) { const copy={ ...item }; groups.push(copy); members.set(copy,[item]); if (!buckets.has(bucketKey)) buckets.set(bucketKey,[]); buckets.get(bucketKey)!.push(copy); for (const hash of mobilePhotoHashes(item.images)) { if (!imageBuckets.has(hash)) imageBuckets.set(hash,[]); imageBuckets.get(hash)!.push(copy); } continue; }
    const publications = [...(target.relatedPosts ?? [publication(target)]), publication(item)];
    // Keep the first result in the requested sort order; never combine photos
    // bound to separate posts or propagate a workflow decision across them.
    const confirmed = members.get(target)!.some(member=>sameEvidence(member,item));
    target.relatedPostMatch = target.relatedPostMatch === "possible" || !confirmed ? "possible" : "confirmed";
    target.relatedPosts = publications;
    members.get(target)!.push(item);
    // Index evidence from every publication, not only the first card. A later
    // repost can share a photograph with the second or third publication.
    for (const hash of mobilePhotoHashes(item.images)) {
      if (!imageBuckets.has(hash)) imageBuckets.set(hash, []);
      if (!imageBuckets.get(hash)!.includes(target)) imageBuckets.get(hash)!.push(target);
    }
  }
  return groups;
}

function publication(item: FacebookWatcherListing) {
  return { listingId: item.listingId, url: item.sourcePostUrl ?? item.originalUrl, groupName: item.groupName };
}

function compatible(a: FacebookWatcherListing, b: FacebookWatcherListing): boolean {
  if (a.source !== "facebook" || b.source !== "facebook" || a.area !== b.area || a.price !== b.price || (a.area == null && a.price == null)) return false;
  const sharedImage = mobilePhotoHashes(a.images).some(hash=>mobilePhotoHashes(b.images).includes(hash));
  if (a.area == null && !sharedImage) return false;
  // A missing price is not enough evidence even when two uploads share a hash.
  // Require a specific street, fractional area and known matching room count.
  if (a.price == null && b.price == null &&
      !(a.street && b.street && fact(a.street,"street")===fact(b.street,"street") &&
        fact(a.street,"street").toString().length>=6 &&
        a.rooms != null && a.rooms===b.rooms && !Number.isInteger(a.area))) return false;
  if (a.status !== b.status || a.lifecycleStatus !== b.lifecycleStatus) return false;
  for (const key of ["rooms", "floor", "city", "district", "neighborhood", "street"] as const) {
    if (a[key] != null && b[key] != null && fact(a[key],key) !== fact(b[key],key)) return false;
  }
  return true;
}

/** A third repost may share a photo only with the second member. Preserve
 * strict matching facts against the first member without requiring its photo. */
function compatibleUnpicturedMember(a: FacebookWatcherListing,b: FacebookWatcherListing):boolean {
  for (const key of ["rooms", "floor", "city", "district", "neighborhood", "street"] as const) {
    if (a[key] != null && b[key] != null && fact(a[key],key) !== fact(b[key],key)) return false;
  }
  return a.source==="facebook" && b.source==="facebook" && a.area===null && b.area===null && a.price!=null && a.price===b.price &&
    a.street!=null && b.street!=null && fact(a.street,"street")===fact(b.street,"street") &&
    a.rooms===b.rooms && a.status===b.status && a.lifecycleStatus===b.lifecycleStatus;
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

/** Exact repeated own text + matching property facts can identify reposts
 * even when Facebook recompresses photographs into different byte hashes. */
function sameEvidence(a: FacebookWatcherListing,b: FacebookWatcherListing): boolean {
  if(a.confirmedDuplicateGroupId && a.confirmedDuplicateGroupId===b.confirmedDuplicateGroupId)return true;
  const hashes=mobilePhotoHashes(a.images);
  if(mobilePhotoHashes(b.images).some(hash=>hashes.includes(hash))) return true;
  const text=(value:string|null)=>value?.normalize("NFKC").toLocaleLowerCase("pl").replace(/\s+/gu," ").trim()??"";
  const own=text(a.description);
  const other=text(b.description);
  if(own.length<120 || other.length<120 || own.split(" ").length<20 || other.split(" ").length<20)return false;
  // Allow small edits, punctuation and extra contact details, but not generic property templates.
  const tokens=(value:string)=>new Set(value.match(/[\p{L}\p{N}]{3,}/gu)??[]);
  const left=tokens(own),right=tokens(other);
  const overlap=[...left].filter(token=>right.has(token)).length;
  const similarity=overlap/Math.max(left.size,right.size,1);
  if(similarity<0.88 || overlap<15)return false;
  return Boolean(a.city && b.city && text(a.city)===text(b.city) && a.rooms && a.rooms===b.rooms &&
    (["street","neighborhood","district"] as const).some(key=>a[key] && b[key] && text(a[key])===text(b[key])));
}

function fact(value:string|number,key:string): string|number {
  if(typeof value!=="string")return value;
  const normalized=value.normalize("NFKC").toLocaleLowerCase("pl").replace(/\s+/gu," ").trim();
  // Android sometimes appends the city and the start of the advertisement
  // to the extracted street. Do not let that suffix invent a second address.
  return key==="street" ? normalized.replace(/\s+w łodzi\s+na sprzedaż(?:\s|$).*$/u,"") : normalized;
}

/** A reversible candidate group, explicitly NOT a confirmed property identity.
 * Android snapshots often have no description, city or rooms and recompressed
 * photos. Keep them together for review only when their exact price and area
 * also share location evidence, or a fractional area and known room count. */
function possibleRepost(a:FacebookWatcherListing,b:FacebookWatcherListing):boolean {
  // Weak OCR-only candidates must not merge across independent CRM decisions.
  if(!compatible(a,b) || a.workflowStatus !== b.workflowStatus || (a.description?.trim() && b.description?.trim()))return false;
  const location=(["street","neighborhood","district"] as const).some(key=>a[key] && b[key] && fact(a[key],key)===fact(b[key],key));
  // Android OCR frequently misses the price entirely. Only present these as
  // POSSIBLE reposts when the same specific street, fractional area and room
  // count all match. Never infer a confirmed identity from these facts.
  if (a.price == null && b.price == null) {
    return Boolean(a.street && b.street && fact(a.street,"street")===fact(b.street,"street") &&
      fact(a.street,"street").toString().length>=6 && a.rooms && a.rooms===b.rooms &&
      !Number.isInteger(a.area) && location);
  }
  // Fractional area plus room count alone is too weak when the location is unknown.
  // Keep it as a separate listing until an address or other property-specific evidence exists.
  if (location) return true;
  // OCR can omit the entire location while retaining a precise combination
  // of price, fractional area and room count. Treat as a POSSIBLE repost only.
  // This does not assert identity or modify the source records.
  return Boolean(a.price != null && b.price != null && a.price > 0 &&
    a.rooms != null && b.rooms != null && a.rooms === b.rooms &&
    !Number.isInteger(a.area) && a.area === b.area &&
    !a.street && !b.street && !a.neighborhood && !b.neighborhood &&
    !a.district && !b.district);
}
