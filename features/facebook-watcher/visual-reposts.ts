import type { FacebookWatcherListing } from "./types";
export type VisualSignature = { dhash: string; ahash: string; mean: [number,number,number]; detail: number; aspect: number };
export type PhotoFingerprint = VisualSignature & { assetHash: string; variants?: VisualSignature[] };
export function mobileImageAsset(value: string): { hash: string; url: string } | null {
  try { const u=new URL(value);const match=/^\/storage\/v1\/object\/public\/facebook-watcher-images\/android\/[0-9a-f-]{36}\/\d{5,30}\/([a-f0-9]{64})\.jpg$/u.exec(u.pathname);return u.protocol==="https:"&&match?{hash:match[1],url:u.href}:null; }catch{return null;}
}
export function readFingerprints(value: unknown): PhotoFingerprint[] {
  if(!Array.isArray(value))return [];
  return value.slice(0,3).flatMap(v=>{if(!v||typeof v!=="object")return [];const f=v as PhotoFingerprint;return /^[a-f0-9]{64}$/.test(f.assetHash)&&/^[a-f0-9]{16}$/.test(f.dhash)&&/^[a-f0-9]{16}$/.test(f.ahash)&&Array.isArray(f.mean)&&f.mean.length===3&&f.mean.every(n=>Number.isFinite(n)&&n>=0&&n<=255)&&Number.isFinite(f.detail)&&f.detail>=0&&f.detail<=255&&Number.isFinite(f.aspect)&&f.aspect>0&&f.aspect<=20?[{...f,variants:Array.isArray(f.variants)?f.variants.slice(0,30).filter(v=>v&&/^[a-f0-9]{16}$/.test(v.dhash)&&/^[a-f0-9]{16}$/.test(v.ahash)&&Array.isArray(v.mean)&&v.mean.length===3&&v.mean.every(n=>Number.isFinite(n)&&n>=0&&n<=255)&&Number.isFinite(v.detail)&&v.detail>=0&&v.detail<=255&&Number.isFinite(v.aspect)&&v.aspect>0&&v.aspect<=20):[]}]:[];});
}
export function hamming(a:string,b:string) { const counts=[0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];let count=0;for(let i=0;i<a.length;i++)count+=counts[parseInt(a[i],16)^parseInt(b[i],16)];return count; }
function popcount(value:number) {
  value-=(value>>>1)&0x55555555;value=(value&0x33333333)+((value>>>2)&0x33333333);
  return (((value+(value>>>4))&0x0f0f0f0f)*0x01010101)>>>24;
}
/** Compile hashes once per photo within one pass; bounding boxes only reject
 * impossible color matches, never replace the original pairwise evidence. */
export function createPhotoMatcher() {
  const cache=new WeakMap<PhotoFingerprint,ReturnType<typeof compile>>();
  function compile(photo:PhotoFingerprint){
    const signatures=[photo,...(photo.variants??[])].filter(s=>s.detail>=16).map(s=>({...s,d0:parseInt(s.dhash.slice(0,8),16),d1:parseInt(s.dhash.slice(8),16),a0:parseInt(s.ahash.slice(0,8),16),a1:parseInt(s.ahash.slice(8),16)}));
    return {signatures,min:[0,1,2].map(i=>Math.min(...signatures.map(s=>s.mean[i]))),max:[0,1,2].map(i=>Math.max(...signatures.map(s=>s.mean[i])))};
  }
  const prepared=(photo:PhotoFingerprint)=>{let value=cache.get(photo);if(!value){value=compile(photo);cache.set(photo,value);}return value;};
  return (a:PhotoFingerprint,b:PhotoFingerprint)=>{
    const left=prepared(a),right=prepared(b);
    if(!left.signatures.length||!right.signatures.length||left.min.some((v,i)=>v>right.max[i]+14||right.min[i]>left.max[i]+14))return false;
    return left.signatures.some(l=>right.signatures.some(r=>Math.abs(l.aspect-r.aspect)/Math.max(l.aspect,r.aspect)<=0.08&&l.mean.every((v,i)=>Math.abs(v-r.mean[i])<=14)&&popcount(l.d0^r.d0)+popcount(l.d1^r.d1)<=6&&popcount(l.a0^r.a0)+popcount(l.a1^r.a1)<=8));
  };
}
export function similarPhoto(a:PhotoFingerprint,b:PhotoFingerprint) { return createPhotoMatcher()(a,b); }

function normalized(v:string|number) { return typeof v==="string"?v.normalize("NFKC").toLocaleLowerCase("pl").replace(/\s+/gu," ").trim():v; }
/** A visual fingerprint alone is never property identity: require corroborating property facts. */
export function visualFactsAgree(a:FacebookWatcherListing,b:FacebookWatcherListing) {
  if(a.source!=="facebook"||b.source!=="facebook"||a.status!==b.status||a.lifecycleStatus!==b.lifecycleStatus||a.workflowStatus!==b.workflowStatus)return false;
  for(const key of ["price","area","rooms","floor","city","district","neighborhood","street"] as const)if(a[key]!=null&&b[key]!=null&&normalized(a[key])!==normalized(b[key]))return false;
  if(a.description?.trim()&&b.description?.trim()&&normalized(a.description)!==normalized(b.description))return false;
  const area=a.area!=null&&a.area>0&&a.area===b.area, rooms=a.rooms!=null&&a.rooms>0&&a.rooms===b.rooms;
  const location=(["street","district","neighborhood"] as const).some(k=>a[k]&&b[k]&&normalized(a[k])===normalized(b[k]));
  // Reader-only snapshots can miss the whole location and asking price. A
  // precise fractional area + known matching rooms can corroborate a visual
  // match, but never merge records by those parameters alone.
  const preciseUnpricedSnapshot=area&&!Number.isInteger(a.area)&&a.price==null&&b.price==null&&!a.description?.trim()&&!b.description?.trim();
  const samePrice=a.price!=null&&a.price>0&&a.price===b.price;
  return area&&(samePrice||(rooms&&(location||preciseUnpricedSnapshot)));
}
/** A fresh matcher is shared within one grouping pass, never across changed records. */
export function createVisualRepostMatcher() {
  const cache=new WeakMap<FacebookWatcherListing,PhotoFingerprint[]>();
  const comparePhotos=createPhotoMatcher();
  const bound=(row:FacebookWatcherListing)=>{
    const cached=cache.get(row);if(cached)return cached;
    const allowed=new Set(row.images.flatMap(u=>{const a=mobileImageAsset(u);return a?[a.hash]:[]}));
    const result=readFingerprints(row.photoFingerprints).filter(f=>allowed.has(f.assetHash));cache.set(row,result);return result;
  };
  return (a:FacebookWatcherListing,b:FacebookWatcherListing)=>{
    if(!a.photoFingerprints?.length||!b.photoFingerprints?.length||!visualFactsAgree(a,b))return false;
    const left=bound(a),right=bound(b);
    return left.some(l=>right.some(r=>comparePhotos(l,r)));
  };
}
export function possibleVisualRepost(a:FacebookWatcherListing,b:FacebookWatcherListing) { return createVisualRepostMatcher()(a,b); }

export function visualCandidates(records:FacebookWatcherListing[]) {
  const buckets=new Map<string,FacebookWatcherListing[]>();
  for(const r of records){if(r.source!=="facebook"||r.workflowStatus==="rejected"||!r.area||!r.images.some(mobileImageAsset))continue;const k=`${r.area}`;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k)!.push(r);}
  return [...buckets.values()].flatMap(group=>group.filter(r=>group.some(other=>other.listingId!==r.listingId&&visualFactsAgree(r,other)))).slice(0,500);
}
