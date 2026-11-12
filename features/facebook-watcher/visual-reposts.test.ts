import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import sharp from "sharp";
import { fingerprintImage } from "./server/image-fingerprint.ts";
import { mobileImageAsset,possibleVisualRepost,similarPhoto,createPhotoMatcher,hamming,visualCandidates,type PhotoFingerprint } from "./visual-reposts.ts";
import { groupFacebookReposts } from "./group-facebook-reposts.ts";
import type { FacebookWatcherListing } from "./types.ts";
const url=(hash:string,post="123456")=>`https://p.supabase.co/storage/v1/object/public/facebook-watcher-images/android/11111111-1111-1111-1111-111111111111/${post}/${hash}.jpg`;
function item(id:string,hash:string,patch:Partial<FacebookWatcherListing>={}) {return {listingId:id,source:"facebook",status:"active",lifecycleStatus:"ACTIVE",workflowStatus:"review",price:null,area:38,rooms:2,floor:null,city:null,district:null,neighborhood:null,street:"Bałuty",description:null,images:[url(hash)],sourcePostUrl:`https://facebook.com/groups/123456/posts/${id}/`,...patch} as FacebookWatcherListing;}
const proof=(assetHash:string):PhotoFingerprint=>({assetHash,dhash:"c3a9f0cd23b831af",ahash:"aa093ddcf0e2ce33",mean:[155,143,132],detail:48,aspect:1.3});
test("recompressed bytes with matching visual evidence render once with every publication preserved",()=>{const rows=["a","b","c"].map((x,i)=>item(String(123456+i),x.repeat(64),{photoFingerprints:[proof(x.repeat(64))]}));const before=structuredClone(rows);const groups=groupFacebookReposts(rows);assert.equal(groups.length,1);assert.equal(groups[0].relatedPosts?.length,3);assert.equal(groups[0].relatedPostMatch,"possible");assert.deepEqual(rows,before);assert.equal(visualCandidates(rows).length,3);});
test("visual matches require matching known facts and image-bound fingerprints",()=>{const a=item("123456","a".repeat(64),{photoFingerprints:[proof("a".repeat(64))]});const b=item("234567","b".repeat(64),{photoFingerprints:[proof("b".repeat(64))]});for(const patch of [{area:39},{rooms:3},{street:"Widzew"},{workflowStatus:"crm" as const},{lifecycleStatus:"ARCHIVED"},{photoFingerprints:[proof("c".repeat(64))]},{photoFingerprints:[{...proof("b".repeat(64)),dhash:"0000000000000000"}]}])assert.equal(possibleVisualRepost(a,{...b,...patch}),false,JSON.stringify(patch));assert.equal(possibleVisualRepost({...a,street:null},{...b,street:null}),false);});
test("visually flat images, strong color differences and sparse bridge cards never collapse homes",()=>{const f=proof("a".repeat(64));assert.equal(similarPhoto(f,{...f,detail:0}),false);assert.equal(similarPhoto(f,{...f,mean:[230,220,210]}),false);const a=item("123456","a".repeat(64),{photoFingerprints:[f]});const b=item("234567","b".repeat(64),{photoFingerprints:[proof("b".repeat(64))]});const c=item("345678","c".repeat(64),{area:39,photoFingerprints:[proof("c".repeat(64))]});assert.equal(groupFacebookReposts([a,b,c]).length,2);assert.equal(mobileImageAsset("https://evil.test/placeholder.jpg"),null);});
test("actual JPEG resizing and recompression are tolerated; different scenes are rejected",async()=>{const w=640,h=480,raw=Buffer.alloc(w*h*3);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=(y*w+x)*3;raw[p]=Math.round(120+60*Math.sin(x/35)+25*Math.cos(y/47));raw[p+1]=Math.round(130+55*Math.sin(y/41)+20*Math.cos(x/57));raw[p+2]=Math.round(140+50*Math.sin((x+y)/51));}const first=await sharp(raw,{raw:{width:w,height:h,channels:3}}).jpeg({quality:95}).toBuffer();const second=await sharp(first).resize(96,72).jpeg({quality:40}).toBuffer();const a=await fingerprintImage(first,"a".repeat(64)),b=await fingerprintImage(second,"b".repeat(64));assert.equal(similarPhoto(a,b),true);const other=await sharp(first).flop().jpeg().toBuffer();assert.equal(similarPhoto(a,await fingerprintImage(other,"c".repeat(64))),false);});

test("reported differently cropped bathroom variants render as one card (offline regression)",()=>{
 const fingerprints=JSON.parse(fs.readFileSync(new URL("./fixtures/reported-bathroom-fingerprints.json",import.meta.url),"utf8")) as PhotoFingerprint[];
 const records=fingerprints.map((f,i)=>item(String(123456+i),f.assetHash,{photoFingerprints:[f]}));assert.equal(records.length,4);const grouped=groupFacebookReposts(records);assert.equal(grouped.length,1);assert.equal(grouped[0].relatedPosts?.length,4);assert.equal(grouped[0].relatedPostMatch,"possible");
});

test("reported 38.4m² one-room snapshots without price or location enter visual analysis",()=>{
 const a=item("123456","a".repeat(64),{area:38.4,rooms:1,street:null,photoFingerprints:[proof("a".repeat(64))]}),b=item("234567","b".repeat(64),{area:38.4,rooms:1,street:null,photoFingerprints:[proof("b".repeat(64))]});
 assert.equal(visualCandidates([a,b]).length,2);assert.equal(possibleVisualRepost(a,b),true);assert.equal(groupFacebookReposts([a,b]).length,1);
 assert.equal(possibleVisualRepost(a,{...b,photoFingerprints:[]}),false);assert.equal(possibleVisualRepost(a,{...b,area:37.4}),false);assert.equal(possibleVisualRepost(a,{...b,rooms:2}),false);assert.equal(possibleVisualRepost(a,{...b,workflowStatus:"crm"}),false);
});

test("priced 33.5m² snapshots without room counts can reach visual matching",()=>{
 const a=item("123456","a".repeat(64),{area:33.5,price:215000,rooms:null,street:null,photoFingerprints:[proof("a".repeat(64))]}),b=item("234567","b".repeat(64),{area:33.5,price:215000,rooms:null,street:null,photoFingerprints:[proof("b".repeat(64))]});
 assert.equal(visualCandidates([a,b]).length,2);assert.equal(groupFacebookReposts([a,b]).length,1);
 assert.equal(possibleVisualRepost(a,{...b,price:220000}),false);assert.equal(possibleVisualRepost(a,{...b,photoFingerprints:[]}),false);
 assert.equal(possibleVisualRepost({...a,rooms:2},{...b,rooms:3}),false);assert.equal(possibleVisualRepost({...a,price:null},{...b,price:null}),false);
});

test("compiled visual matching preserves all original thresholds and crop-pair semantics",()=>{
 const matches=createPhotoMatcher();let seed=241;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};const hash=()=>random().toString(16).padStart(8,"0")+random().toString(16).padStart(8,"0");
 const sig=()=>({dhash:hash(),ahash:hash(),mean:[random()%256,random()%256,random()%256] as [number,number,number],detail:random()%60,aspect:0.5+(random()%120)/100});
 const pair=(a:PhotoFingerprint,b:PhotoFingerprint)=>[a,...(a.variants??[])].some(l=>[b,...(b.variants??[])].some(r=>l.detail>=16&&r.detail>=16&&Math.abs(l.aspect-r.aspect)/Math.max(l.aspect,r.aspect)<=0.08&&l.mean.every((v,i)=>Math.abs(v-r.mean[i])<=14)&&hamming(l.dhash,r.dhash)<=6&&hamming(l.ahash,r.ahash)<=8));
 for(let i=0;i<1000;i++){
  const a={assetHash:"a".repeat(64),...sig(),variants:[sig(),sig(),sig()]};const b={assetHash:"b".repeat(64),...sig(),variants:[sig(),sig()]};
  if(i%3===0)b.variants.push({...a.variants[1],mean:a.variants[1].mean.map((v,j)=>v+(i%31-15)*(j===0?1:0)) as [number,number,number]});
  if(i%5===0){b.dhash=a.dhash;b.ahash=a.ahash;b.mean=[...a.mean];b.aspect=a.aspect;b.detail=a.detail;}
  assert.equal(matches(a,b),pair(a,b),`case ${i}`);
 }
});

test("compiled hash distances preserve six/eight bit boundaries across 32-bit halves",()=>{
 const match=createPhotoMatcher();const base=proof("a".repeat(64));base.dhash="0".repeat(16);base.ahash="0".repeat(16);
 const bits=(count:number,start:number)=>{const b=Array.from({length:64},(_,i)=>i>=start&&i<start+count?"1":"0").join("");return parseInt(b.slice(0,32),2).toString(16).padStart(8,"0")+parseInt(b.slice(32),2).toString(16).padStart(8,"0");};
 for(const start of [0,28,40])for(let d=0;d<=12;d++)for(let a=0;a<=12;a++)assert.equal(match(base,{...base,dhash:bits(d,start),ahash:bits(a,start)}),d<=6&&a<=8,`${start}/${d}/${a}`);
});
