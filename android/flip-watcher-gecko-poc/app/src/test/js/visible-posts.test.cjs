const {test} = require("node:test");
const assert = require("node:assert/strict");
const v = require("../../main/extension/visible-posts.js");
const groupId = "lodzsprzedazzakupwynajem";
const href = `https://www.facebook.com/groups/${groupId}/`;
const input = {consent:true, groupId, href, visible:true, cards:[{semantic:true,text:"Cena 450 000 zł, 54,5 m², 3 pokoje, dzielnica: Widzew",hrefs:[`${href}posts/123456789/`], photos:1}]};
test("new explicit consent required, old consent is insufficient",()=>{assert.equal(v.analyze({...input,consent:false,scanConsent:true}).status,"STOP");assert.equal(v.analyze({...input,consent:undefined}).status,"STOP");});
test("approved slug only; page changes, hidden, login and CAPTCHA stop",()=>{for(const change of [{href:"https://www.facebook.com/login/"},{href:href.replace(groupId,"other")},{visible:false},{blocked:true},{href:href+"?token=secret"}])assert.equal(v.analyze({...input,...change}).status,"STOP");});
test("confirmed links distinct from heuristic fields, counts only",()=>{const out=v.analyze(input);assert.equal(out.counts.confirmedIds,1);for(const key of ["priceCandidates","areaCandidates","roomCandidates","districtCandidates","photoCandidates"])assert.equal(out.counts[key],1);const json=JSON.stringify(out);assert.ok(!json.includes("123456789"));assert.ok(!json.includes("Widzew"));});
test("fake IDs, photo fbid, foreign groups and arbitrary numbers rejected",()=>{for(const link of [`${href}?fbid=123`,"https://evil.com/groups/"+groupId+"/posts/123/",href+"photos/123/",href+"posts/not-an-id/",href.replace(groupId,"other")+"posts/123/","123456789"])assert.equal(v.exact(link,groupId),null);});
test("cap 20, deduplicate ID; mobile candidates remain heuristic",()=>{const out=v.analyze({...input,cards:Array(30).fill({...input.cards[0],semantic:false})});assert.equal(out.counts.candidates,20);assert.equal(out.counts.confirmedIds,1);assert.equal(out.counts.heuristicCandidates,20);});
test("no retained results after clear or session interruption",()=>{v.analyze(input);assert.equal(v.analyze({...input,consent:false,cards:[]}).status,"STOP");assert.equal(v.analyze({...input,cards:[]}).counts.confirmedIds,0);});
test("diagnosis module isolated from storage, network and scan",()=>{const fs=require("node:fs");const src=fs.readFileSync(require.resolve("../../main/extension/visible-posts.js"),"utf8");assert.doesNotMatch(src,/fetch\s*\(|XMLHttpRequest|localStorage|cookies|filterResponseData|scan\s*\(|console\./);});
test("without consent rendered DOM is never queried",()=>{
  const win={document:{querySelector(){throw Error('unauthorized DOM read')}},location:{href}};
  assert.equal(v.read(win,{consent:false,groupId}).status,"STOP");
});
test("page interruption and data clearing dispose the observer",()=>{
  let callback, disconnected=0, stopped=0;
  const listeners=new Map();
  const win={location:{href},document:{title:"group",body:{innerText:""},visibilityState:"visible",documentElement:{},querySelector(){return null},addEventListener(n,f){listeners.set(n,f)},removeEventListener(n){listeners.delete(n)}},MutationObserver:class{constructor(f){callback=f}observe(){}disconnect(){disconnected++}},addEventListener(n,f){listeners.set(n,f)},removeEventListener(n){listeners.delete(n)}};
  const clear=v.watch(win,{groupId},()=>stopped++);
  clear(); assert.equal(disconnected,1);assert.equal(stopped,0);assert.equal(listeners.size,0);
  v.watch(win,{groupId},()=>stopped++);win.location.href=href.replace(groupId,"other");callback();assert.equal(stopped,1);assert.equal(disconnected,2);assert.equal(listeners.size,0);
});

test("lost group access stops before card extraction",()=>{
 const win={innerWidth:500,innerHeight:900,location:{href},document:{title:"Facebook",body:{innerText:"Ta zawartość jest niedostępna"},visibilityState:"visible",querySelector(){return null},querySelectorAll(){throw Error("cards read after STOP")}}};
 assert.equal(v.read(win,{consent:true,groupId}).status,"STOP");
});
