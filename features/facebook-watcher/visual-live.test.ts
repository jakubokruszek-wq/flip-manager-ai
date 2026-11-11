import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
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
 fs.mkdirSync("test-artifacts/visual-photos",{recursive:true});const fingerprints=[];for(const [post,hash] of samples){const r=await fetch(`https://zmuisdirvfcxrvtbvrle.supabase.co/storage/v1/object/public/facebook-watcher-images/android/17b58632-1d58-48f5-8d0e-04d74dc5e96e/${post}/${hash}.jpg`,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const b=new Uint8Array(await r.arrayBuffer());assert.equal(createHash("sha256").update(b).digest("hex"),hash);fs.writeFileSync(`test-artifacts/visual-photos/sample-${fingerprints.length}.jpg`,b);const m=await sharp(b).metadata();console.log(JSON.stringify({sample:fingerprints.length,width:m.width,height:m.height}));fingerprints.push(await fingerprintImage(b,hash));}
 const results=[];for(let i=0;i<fingerprints.length;i++)for(let j=i+1;j<fingerprints.length;j++){console.log(JSON.stringify({pair:[i,j],dhash:hamming(fingerprints[i].dhash,fingerprints[j].dhash),ahash:hamming(fingerprints[i].ahash,fingerprints[j].ahash),means:[fingerprints[i].mean,fingerprints[j].mean],aspect:[fingerprints[i].aspect,fingerprints[j].aspect]}));results.push({pair:[i,j],match:similarPhoto(fingerprints[i],fingerprints[j])});}
 fs.writeFileSync("test-artifacts/visual-photos/results.json",JSON.stringify({fingerprints,results},null,2));assert.ok(results.every(r=>r.match),JSON.stringify(results));
});

test("reported stairs pair with 38.4m² and no asking price/location matches visually",{skip:process.env.WATCHER_VISUAL_LIVE_FIXTURES!=="1",timeout:30000},async()=>{
 const sources=[["1604404324242335","16e60697453e1285f99fc09b7cc9894581c2e145b9e4056d20e73f8adc127af9"],["3764029387092090","cb4e7a4f157580c21de4d0a317422a7d5f2bf222a5cd177d017460b49c3ff635"]];const fingerprints=[];fs.mkdirSync("test-artifacts/visual-photos",{recursive:true});
 for(const [post,hash] of sources){const response=await fetch(`https://zmuisdirvfcxrvtbvrle.supabase.co/storage/v1/object/public/facebook-watcher-images/android/17b58632-1d58-48f5-8d0e-04d74dc5e96e/${post}/${hash}.jpg`,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(createHash("sha256").update(bytes).digest("hex"),hash);fs.writeFileSync(`test-artifacts/visual-photos/stairs-${fingerprints.length}.jpg`,bytes);fingerprints.push(await fingerprintImage(bytes,hash));}
 fs.writeFileSync("test-artifacts/visual-photos/stairs-fingerprints.json",JSON.stringify(fingerprints));assert.equal(similarPhoto(fingerprints[0],fingerprints[1]),true);
});

test("reported unpriced-room 215k snapshots match actual photographs",{skip:process.env.WATCHER_VISUAL_LIVE_FIXTURES!=="1",timeout:30000},async()=>{
 const sources=[["3442635112605200","e20c8bf6abf75a096e500b3c1c1fc781e90fc4a273aecc05e73ca7d00db79e43"],["1783543682871033","aca77df02ca41f97e91a02d21229cf157cfcbb87d34a1d5a42e1125aa6c4b70e"],["1816615902588860","fec30e80d2df19f53d267444a24eb6a4ae8d26d26336a62347d6f7f286a165c7"]];const prints=[];fs.mkdirSync("test-artifacts/visual-photos",{recursive:true});
 for(const [post,hash]of sources){const response=await fetch(`https://zmuisdirvfcxrvtbvrle.supabase.co/storage/v1/object/public/facebook-watcher-images/android/17b58632-1d58-48f5-8d0e-04d74dc5e96e/${post}/${hash}.jpg`,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(createHash("sha256").update(bytes).digest("hex"),hash);fs.writeFileSync(`test-artifacts/visual-photos/kitchen-${prints.length}.jpg`,bytes);prints.push(await fingerprintImage(bytes,hash));}
 const matches=[];for(let i=0;i<prints.length;i++)for(let j=i+1;j<prints.length;j++)matches.push({i,j,match:similarPhoto(prints[i],prints[j])});fs.writeFileSync("test-artifacts/visual-photos/kitchen-results.json",JSON.stringify({prints,matches}));assert.ok(matches.every(p=>p.match),JSON.stringify(matches));
});
