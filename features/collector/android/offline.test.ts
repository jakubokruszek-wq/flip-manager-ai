import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { extractFacebookProperty } from "../../facebook-watcher/extract-facebook-property.ts";
import { resolveFacebookListingIntent } from "../../facebook-watcher/facebook-intent.ts";

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync("extensions/facebook-collector/collector-core.js", "utf8"), context);
vm.runInContext(fs.readFileSync("android/flip-collector/app/src/main/assets/facebook-offline-adapter.js", "utf8"), context);
const adapter = context.FlipAndroidOfflineAdapter;
const source = { sourceId: "offline-lodz", sourceType: "GROUP", sourceUrl: "https://www.facebook.com/groups/offline-lodz/" };
const html = fs.readFileSync("android/flip-collector/app/src/androidTest/assets/offline-source.html", "utf8");
// DOM facade for deterministic Node tests of structured scripts. The actual
// HTML parser/WebView is tested separately in Android instrumentation, not here.
function documentFromScripts(text: string) {
  const scripts = [...text.matchAll(/<script type="application\/json">([\s\S]*?)<\/script>/g)].map(match => ({ textContent: match[1] }));
  return { querySelectorAll: (selector: string) => selector.startsWith("script") ? scripts : [] };
}
test("offline adapter uses unchanged extension identity and excludes neighbor media", () => {
  const result = adapter.collect(documentFromScripts(html), source);
  assert.equal(result.posts.length, 3);
  const sale=result.posts.find((p: {postId:string})=>p.postId==="100000000001");
  assert.equal(sale.identityConfidence,"EXACT"); assert.equal(sale.author,"Autor Testowy");
  assert.equal(sale.media.length,1); assert.equal(sale.media[0].mediaId,"200000000001");
  assert.ok(sale.publishedAt);
});
test("offline text feeds existing server price, location, rooms and intent logic", async () => {
  const posts=adapter.collect(documentFromScripts(html),source).posts;
  const sale=await extractFacebookProperty({postText:posts[0].text,images:[]});
  assert.equal(sale.price,260000);assert.equal(sale.area,42);assert.equal(sale.rooms,2);assert.equal(sale.city,"Łódź");
  assert.equal(resolveFacebookListingIntent(posts[0].text,null,null).intent,"SELL_PROPERTY");
  assert.equal(resolveFacebookListingIntent(posts[1].text,null,null).intent,"RENT_OFFER");
  assert.equal(resolveFacebookListingIntent(posts[2].text,null,null).intent,"BUY_PROPERTY");
});
test("cross-group document cannot provide accepted posts", () => {
  const result=adapter.collect(documentFromScripts(html),{...source,sourceId:"other",sourceUrl:"https://www.facebook.com/groups/other/"});
  assert.equal(result.posts.length,0);
});
test("DOM-only card stays unverified and drops all images", () => {
  const card={innerText:"Sprzedam 260 tyś.",querySelectorAll:(selector:string)=>selector==="img"?[{}]:[{href:source.sourceUrl+"posts/100000000004/"}]};
  const result=adapter.collect({querySelectorAll:(selector:string)=>selector.startsWith("script")?[]:[card]},source);
  assert.equal(result.posts[0].identityConfidence,"UNVERIFIED");assert.equal(result.posts[0].media.length,0);assert.equal(result.diagnostics.rejectedImages,1);
});
test("conflicting root stories are never promoted to EXACT", () => {
  const scripts = {querySelectorAll:(selector:string)=>selector.startsWith("script")?[{textContent:JSON.stringify({stories:["A","B"].map(author=>({__typename:"Story",post_id:"100000000001",permalink_url:source.sourceUrl+"posts/100000000001/",actor:{name:author},message:{text:"Sprzedam mieszkanie"}}))})}]:[]};
  const result=adapter.collect(scripts,source);assert.equal(result.posts[0].identityConfidence,"UNVERIFIED");assert.equal(result.posts[0].media.length,0);
});
