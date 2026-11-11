import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { fingerprintImage } from "./server/image-fingerprint.ts";
import { similarPhoto,hamming } from "./visual-reposts.ts";
// Public, content-addressed app assets from the reported 38m²/2-room reposts.
const samples=[
 ["4682416898682676","fa30fa12322598083e7c634215a8d0a7a6d547f4a91b6e40b1ceaffa97a349e5"],
 ["3202501496607230","672155b232524db3f2a7ea6f9d345354f3417fce601f0ccefa788df38999819c"],
 ["29985885837680576","ed7673d87cdc2848440dd88c7bc577db17e8361bf95abf989548a4d993115d5f"],
 ["3762792143882481","cc509eaca5c115a16e5d2840e97dda6a6fffb4c05fcda738fb3294ac64a7cae1"]
];
test("reported bathroom photographs match despite different uploaded JPEG hashes",{skip:process.env.WATCHER_VISUAL_LIVE_FIXTURES!=="1",timeout:60000},async()=>{
 const fingerprints=[];for(const [post,hash] of samples){const r=await fetch(`https://zmuisdirvfcxrvtbvrle.supabase.co/storage/v1/object/public/facebook-watcher-images/android/17b58632-1d58-48f5-8d0e-04d74dc5e96e/${post}/${hash}.jpg`,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const b=new Uint8Array(await r.arrayBuffer());assert.equal(createHash("sha256").update(b).digest("hex"),hash);const m=await sharp(b).metadata();console.log(JSON.stringify({sample:fingerprints.length,width:m.width,height:m.height}));fingerprints.push(await fingerprintImage(b,hash));}
 for(let i=0;i<fingerprints.length;i++)for(let j=i+1;j<fingerprints.length;j++){console.log(JSON.stringify({pair:[i,j],dhash:hamming(fingerprints[i].dhash,fingerprints[j].dhash),ahash:hamming(fingerprints[i].ahash,fingerprints[j].ahash),means:[fingerprints[i].mean,fingerprints[j].mean],aspect:[fingerprints[i].aspect,fingerprints[j].aspect]}));assert.equal(similarPhoto(fingerprints[i],fingerprints[j]),true);}
});
