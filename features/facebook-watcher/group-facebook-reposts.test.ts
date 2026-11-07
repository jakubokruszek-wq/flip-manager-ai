import assert from "node:assert/strict";
import test from "node:test";
import { groupFacebookReposts } from "./group-facebook-reposts.ts";
import type { FacebookWatcherListing } from "./types.ts";
const image=(post:string,hash="a".repeat(64))=>`https://project.supabase.co/storage/v1/object/public/facebook-watcher-images/android/11111111-1111-1111-1111-111111111111/${post}/${hash}.jpg`;
const item=(id:string,patch:Partial<FacebookWatcherListing>={})=>({listingId:id,source:"facebook",price:300000,area:50,rooms:2,floor:2,city:"Łódź",district:null,neighborhood:null,street:null,workflowStatus:"review",status:"active",groupName:id,sourcePostUrl:`https://facebook.com/groups/${id}/posts/123456/`,originalUrl:null,images:[image(id)],...patch} as FacebookWatcherListing);

test("matching uploaded bytes and parameters group reposts without mutating records or combining post-bound photos",()=>{
  const first=item("123456"),second=item("234567",{images:[image("234567"),image("234567","b".repeat(64))]});
  const before=structuredClone([first,second]);const result=groupFacebookReposts([first,second]);
  assert.equal(result.length,1);assert.equal(result[0].relatedPosts?.length,2);
  assert.deepEqual(result[0].images,first.images);assert.deepEqual([first,second],before);
  assert.deepEqual(result[0].relatedPosts?.map(post=>post.listingId),[first.listingId,second.listingId]);
});
test("equal price and area alone never hide another post",()=>{
  assert.equal(groupFacebookReposts([item("123456"),item("234567",{images:[image("234567","b".repeat(64))]})]).length,2);
});
test("different property facts remain separate even with a reused photograph",()=>{
  for(const patch of [{price:310000},{area:51},{rooms:3},{street:"Inna"},{status:"removed"}]){
    const first=item("123456",{street:"Rojna"}),second=item("234567",{street:"Rojna",...patch});
    assert.equal(groupFacebookReposts([first,second]).length,2,JSON.stringify(patch));
  }
});
test("arbitrary image filenames, shared placeholders and missing parameters cannot group offers",()=>{
  for(const patch of [{images:["https://cdn.test/same.jpg"]},{images:[]},{price:null},{area:null,images:[]}]) assert.equal(groupFacebookReposts([item("123456",patch),item("234567",patch)]).length,2);
});

test("three groups with recompressed photos and identical detailed own text render once with all source links",()=>{
  const description="Sprzedam bezpośrednio mieszkanie na Bałutach przy ulicy Rojnej w Łodzi. Dwa ustawne pokoje, oddzielna kuchnia, balkon i piwnica. Lokal dostępny od zaraz, po generalnym remoncie instalacji, podłóg oraz ścian. Cena obejmuje całe wyposażenie widoczne na zdjęciach.";
  const posts=["123456","234567","345678"].map((id,i)=>item(id,{description:i===1?description.replaceAll(" ","  "):description,street:"Rojna",images:[image(id,String(i+1).repeat(64))]}));
  const before=structuredClone(posts);
  const grouped=groupFacebookReposts(posts);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].relatedPosts?.length,3);
  assert.deepEqual(grouped[0].relatedPosts?.map(p=>p.groupName),posts.map(p=>p.groupName));
  assert.deepEqual(posts,before,"source offers and group links remain unchanged");
  assert.deepEqual(grouped[0].images,posts[0].images,"photos remain bound to their own post");
  assert.equal(groupFacebookReposts([posts[0],{...posts[1],rooms:3}]).length,2);
  assert.equal(groupFacebookReposts([posts[0],{...posts[1],description:"Sprzedam inne mieszkanie przy Rojnej, dwa pokoje, inny rozkład i inne wyposażenie."}]).length,2);
});

test("every member's photograph participates in detecting another publication",()=>{
  const a=item("123456");
  const b=item("234567",{images:[image("234567"),image("234567","b".repeat(64))]});
  const c=item("345678",{images:[image("345678","b".repeat(64))]});
  assert.equal(groupFacebookReposts([a,b,c])[0].relatedPosts?.length,3);
});

test("short shared boilerplate and unknown location cannot join distinct homes",()=>{
  const description="Sprzedam mieszkanie. Zapraszam do kontaktu.";
  assert.equal(groupFacebookReposts([item("123456",{description}),item("234567",{description,images:[]})]).length,2);
});

test("real Android snapshot shape: null descriptions/city/rooms and recompressed photos form a clearly possible group",()=>{
  const snapshots=["2391919654676416","29887029747566186","3001324956895261","1720514219592972"].map((id,i)=>item(id,{title:"Oferta z Facebooka",price:699000,area:75,description:null,city:null,rooms:null,floor:null,street:i===2?"Dębowej w ŁODZI Na sprzedaż przestronne":"Dębowej",images:[image(id,String(i+1).repeat(64))]}));
  const grouped=groupFacebookReposts(snapshots);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].relatedPosts?.length,4);
  assert.equal(grouped[0].relatedPostMatch,"possible","matching parameters are never presented as confirmed image identity");
  assert.deepEqual(snapshots.map(i=>i.relatedPosts),[undefined,undefined,undefined,undefined]);
});

test("precise fractional area, price and rooms group location-free Android snapshots as possible",()=>{
  const snapshots=["123456","234567","345678"].map((id,i)=>item(id,{price:337500,area:48.24,rooms:3,city:null,description:null,images:[image(id,String(i+1).repeat(64))]}));
  const grouped=groupFacebookReposts(snapshots);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].relatedPostMatch,"possible");
  assert.equal(grouped[0].relatedPosts?.length,3);
  assert.equal(grouped[0].city,null);assert.equal(grouped[0].street,null);
  const located=snapshots.map(p=>({...p,street:"Rojna"}));
  const possible=groupFacebookReposts(located);
  assert.equal(possible.length,1);
  assert.equal(possible[0].relatedPostMatch,"possible");
  assert.equal(groupFacebookReposts([located[0],{...located[1],rooms:2}]).length,2);
  assert.equal(groupFacebookReposts([located[0],{...located[1],workflowStatus:"crm"}]).length,2);
});


test("verified pair with integer area and no location forms one confirmed card without deleting sources",()=>{
 const posts=["123456","234567"].map((id,i)=>item(id,{price:299000,area:60,rooms:3,city:null,street:null,description:null,confirmedDuplicateGroupId:"verified-pair",images:[image(id,String(i+1).repeat(64))]}));
 const grouped=groupFacebookReposts(posts);assert.equal(grouped.length,1);assert.equal(grouped[0].relatedPosts?.length,2);assert.equal(grouped[0].relatedPostMatch,"confirmed");
 assert.equal(groupFacebookReposts([posts[0],{...posts[1],price:999000}]).length,2,"a key never overrides conflicting facts");
});

test("small description edits do not split a verified long repost",()=>{
  const description="Sprzedam bezpośrednio mieszkanie na Bałutach przy ulicy Rojnej w Łodzi. Dwa ustawne pokoje, oddzielna kuchnia, balkon i piwnica. Lokal dostępny od zaraz, po generalnym remoncie instalacji, podłóg oraz ścian. Cena obejmuje całe wyposażenie widoczne na zdjęciach.";
  const first=item("123456",{description,street:"Rojna",images:[image("123456","a".repeat(64))]});
  const second=item("234567",{description:description.replace("oddzielna kuchnia","osobna kuchnia"),street:"Rojna",images:[image("234567","b".repeat(64))]});
  const grouped=groupFacebookReposts([first,second]);
  assert.equal(grouped.length,1);assert.equal(grouped[0].relatedPostMatch,"confirmed");
});

test("integer area or absent rooms or conflicting price never create a location-free candidate",()=>{
  const first=item("123456",{price:337500,area:48.24,rooms:3,city:null,description:null,images:[]});
  for(const patch of [{area:48},{rooms:null},{price:337600},{street:"Other"}]){
    const second=item("234567",{...first,...patch,listingId:"234567"});
    assert.equal(groupFacebookReposts([first,second]).length,2,JSON.stringify(patch));
  }
});

test("same uploaded photo with matching price and missing area groups safely",()=>{
 const first=item("123456",{price:408000,area:null,rooms:null,city:null,street:"Retkinia"});
 const second=item("234567",{price:408000,area:null,rooms:null,city:null,street:"Retkinia",images:[image("234567")]});
 const grouped=groupFacebookReposts([first,second]);
 assert.equal(grouped.length,1);assert.equal(grouped[0].relatedPosts?.length,2);
 assert.equal(grouped[0].relatedPostMatch,"confirmed");
 assert.equal(groupFacebookReposts([first,{...second,price:409000}]).length,2);
 assert.equal(groupFacebookReposts([first,{...second,images:[image("234567","b".repeat(64))]}]).length,2);
});

test("verified identical uploaded photo groups across review and CRM while preserving original statuses",()=>{
 const a=item("123456",{workflowStatus:"review",street:"Rojna"});
 const b=item("234567",{workflowStatus:"crm",street:"Rojna"});
 const grouped=groupFacebookReposts([a,b]);
 assert.equal(grouped.length,1);
 assert.equal(grouped[0].relatedPostMatch,"confirmed");
 assert.equal(grouped[0].relatedPosts?.length,2);
 assert.equal(a.workflowStatus,"review");assert.equal(b.workflowStatus,"crm");
});
