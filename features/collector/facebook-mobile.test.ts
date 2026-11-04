import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createMobilePost, parseMobilePost } from "./facebook-mobile.ts";

const device="12345678-1234-1234-1234-123456789012", listing="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function snapshot() {
  return { version:1, groupId:"lodzsprzedazzakupwynajem", row: { postId:"123456789", permalink:"https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/123456789/", layer:"DOM", price:430000, priceSource:"EXPLICIT_TOTAL", area:50, rooms:2, district:"Bałuty", neighborhood:null, street:null, intent:"SELL_PROPERTY", usable:true, photos:0, qualification:"CLASSIFIER" }, photos:[{slot:0,jpeg:jpeg()}] as Array<{slot:number;jpeg:string}> };
}
// Synthetic SOF headers test transport bounds; Gecko instrumentation tests rendering.
const jpeg=(w=192,h=144)=>Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,h>>8,h&255,w>>8,w&255,1,1,0x11,0,0xff,0xd9]).toString("base64");
function frozen(j=snapshot()) { const raw=JSON.stringify(j); return { raw, key:"mobile-v1:"+createHash("sha256").update(`${device}/${j.groupId}/${j.row.postId}/`).update(raw).digest("hex") }; }
function request(value=frozen(),token=true) { return new Request("https://manager.test/api/collector/facebook/mobile",{method:"POST",headers:{...(token?{authorization:"Bearer paired"}:{}),"idempotency-key":value.key},body:value.raw}); }

test("mobile typed data never invents source text, author or publication date",()=>{
  const {raw,key}=frozen(), post=parseMobilePost(raw,device,key);
  assert.equal(post.price,430000);assert.equal(post.location,"Bałuty");
  assert.equal("content" in post,false);assert.equal("publishedAt" in post,false);
});
test("frozen body is bound to device, group, post and bytes",()=>{
  const {raw,key}=frozen();
  assert.throws(()=>parseMobilePost(raw,listing,key));
  assert.throws(()=>parseMobilePost(raw.replace("430000","440000"),device,key));
  assert.throws(()=>parseMobilePost(raw,device,"arbitrary"));
});
test("reject mismatched post, arbitrary attachments, oversized crop and duplicate slots",()=>{
  const mismatch=snapshot();mismatch.row.permalink=mismatch.row.permalink.replace("123456789","987654321");
  const bad=snapshot();bad.photos=[{slot:0,jpeg:Buffer.from("private attachment").toString("base64")}];
  // Minimal synthetic SOF image headers: test the transport dimensions, not JPEG rendering.
  const large=snapshot();large.photos=[{slot:0,jpeg:jpeg(1080,1920)}];
  const duplicate=snapshot();duplicate.photos=[{slot:0,jpeg:jpeg(192,144)},{slot:0,jpeg:jpeg(192,144)}];
  for(const item of [mismatch,bad,large,duplicate]){const {raw,key}=frozen(item);assert.throws(()=>parseMobilePost(raw,device,key));}
  const valid=snapshot();valid.photos=[{slot:0,jpeg:jpeg(192,144)}];const {raw,key}=frozen(valid);assert.equal(parseMobilePost(raw,device,key).photos.length,1);
});
test("lost response after commit and repeated scan produce one canonical listing",async()=>{
  const imports=new Map<string,string>(), listings=new Map<string,string>(), imageObjects=new Set<string>();let calls=0;
  const handler=createMobilePost({authenticate:async()=>({id:device}),allowed:async()=>true,authStatus:()=>null,
    upload:async(_device,post)=>post.photos.map(p=>{imageObjects.add(p.hash);return `https://storage.test/${p.hash}.jpg`;}),
    importPost:async(_device,key,post)=>{calls++;if(imports.has(key))return {listingId:imports.get(key)!,status:"duplicate"};const existing=listings.has(post.postId);const id=listings.get(post.postId)??listing;listings.set(post.postId,id);imports.set(key,id);return {listingId:id,status:existing?"updated":"created"};}});
  const post=snapshot();post.photos=[{slot:0,jpeg:jpeg()}];const value=frozen(post);
  const first=await handler(request(value));assert.equal(first.status,201); // client loses this response
  const retry=await handler(request(value));assert.equal(retry.status,200);assert.equal((await retry.json()).status,"duplicate");
  const changed=snapshot();changed.photos=post.photos;changed.row.price=440000;assert.equal((await handler(request(frozen(changed)))).status,200);
  assert.equal(listings.size,1);assert.equal(calls,3);assert.equal(imageObjects.size,1);
});
test("no receipt on failed persistence, revoked token, disabled source or oversized body",async()=>{
  let imported=0;
  const deps={authenticate:async()=>({id:device}),allowed:async()=>true,authStatus:()=>null,
    upload:async()=>{throw new Error("lost storage");},importPost:async()=>{imported++;return {listingId:listing,status:"created"};}};
  assert.equal((await createMobilePost(deps)(request())).status,503);assert.equal(imported,0);
  assert.equal((await createMobilePost(deps)(request(frozen(),false))).status,401);
  assert.equal((await createMobilePost({...deps,allowed:async()=>false})(request())).status,409);
  const response=await createMobilePost(deps)(new Request("https://manager.test",{method:"POST",headers:{authorization:"Bearer paired"},body:"x".repeat(512*1024+1)}));assert.equal(response.status,413);
});

// Text on a genuine bound JPEG is allowed: no OCR or image-content classifier is invoked here.
test("require a confirmed property sale and at least one stored image, without inspecting image text", async () => {
  let uploads=0, imports=0;
  const handler=createMobilePost({authenticate:async()=>({id:device}),allowed:async()=>true,authStatus:()=>null,
    upload:async()=>{uploads++;return ["https://storage.test/text-poster.jpg"];},
    importPost:async()=>{imports++;return {listingId:listing,status:"created"};}});
  const missing=snapshot();missing.photos=[];
  assert.equal((await handler(request(frozen(missing)))).status,422);
  for(const intent of ["UNKNOWN","BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER"]){
    const row=snapshot();row.row.intent=intent;assert.equal((await handler(request(frozen(row)))).status,422);
  }
  for(const qualification of ["NO_TEXT","FOREIGN_CITY","NOT_PROPERTY","INTENT","CONFLICT"]){
    const row=snapshot();row.row.qualification=qualification;assert.equal((await handler(request(frozen(row)))).status,422);
  }
  assert.equal(uploads,0);assert.equal(imports,0);
  assert.equal((await handler(request())).status,201);assert.equal(uploads,1);assert.equal(imports,1);
});

test("an upload that returned no stored image cannot create an offer or receipt", async () => {
  let imports=0;const handler=createMobilePost({authenticate:async()=>({id:device}),allowed:async()=>true,authStatus:()=>null,upload:async()=>[],
    importPost:async()=>{imports++;return {listingId:listing,status:"created"};}});
  assert.equal((await handler(request())).status,503);assert.equal(imports,0);
});

test("previously removed posts stop before storing photos or retrying import",async()=>{
 let writes=0;const handler=createMobilePost({authenticate:async()=>({id:device}),allowed:async()=>true,removed:async()=>true,authStatus:()=>null,
  upload:async()=>{writes++;return [];},importPost:async()=>{writes++;return {listingId:listing,status:"created"};}});
 assert.equal((await handler(request())).status,410);assert.equal(writes,0);
});

test("v2 carries only bounded source post text while v1 remains unchanged and bytes stay signed",async()=>{
 const text="NA SPRZEDAŻ:\nRetkinia ul. Kostki Napierskiego 7\n2 pokoje 42.42m2\n339.000 do negocjacji";
 const j={...snapshot(),version:2,postText:text};const packet=frozen(j);
 assert.equal(parseMobilePost(packet.raw,device,packet.key).postText,text);
 const v1=frozen();assert.equal(parseMobilePost(v1.raw,device,v1.key).postText,null);
 assert.throws(()=>parseMobilePost(packet.raw.replace('339.000','349.000'),device,packet.key));
 for(const postText of [null,'','x'.repeat(12001),'bad\u0000text']){const invalid=frozen({...j,postText} as typeof j);assert.throws(()=>parseMobilePost(invalid.raw,device,invalid.key));}
 const extra=frozen({...j,untrusted:'extra'} as typeof j);assert.throws(()=>parseMobilePost(extra.raw,device,extra.key));
});
