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
test("different facts or operator workflow remain separate even with a reused photograph",()=>{
  for(const patch of [{price:310000},{area:51},{rooms:3},{street:"Inna"},{workflowStatus:"crm" as const},{status:"removed"}]){
    const first=item("123456",{street:"Rojna"}),second=item("234567",{street:"Rojna",...patch});
    assert.equal(groupFacebookReposts([first,second]).length,2,JSON.stringify(patch));
  }
});
test("arbitrary image filenames, shared placeholders and missing parameters cannot group offers",()=>{
  for(const patch of [{images:["https://cdn.test/same.jpg"]},{images:[]},{price:null},{area:null}]) assert.equal(groupFacebookReposts([item("123456",patch),item("234567",patch)]).length,2);
});
