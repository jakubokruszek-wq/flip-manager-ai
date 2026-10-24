const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,fields=require('../../main/extension/desktop-fields.js'),preview=require('../../main/extension/desktop-preview.js');
const group='lodzsprzedazzakupwynajem',url=`https://www.facebook.com/groups/${group}/`,nonce='12345678-1234-1234-1234-123456789012';
function env(action){let clock=0,watch,abort,disposed=false,paused=false;const sent=[],notices=[];
 const w={location:{href:url},performance:{timeOrigin:1000,now:()=>clock},innerWidth:980,innerHeight:800,scrollY:0,
  document:{scrollingElement:{scrollHeight:50000,clientHeight:800},querySelectorAll(){return[]}},
  FlipVisiblePosts:{watch(_w,_m,f){watch=f;return()=>{disposed=true}}},
  scrollBy(o){this.scrollY=Math.min(this.document.scrollingElement.scrollHeight-this.document.scrollingElement.clientHeight,this.scrollY+o.top)},setTimeout(fn,ms){queueMicrotask(()=>{clock+=ms;if((action==='unsafe'||action==='lateUnsafe'&&clock>=12000)&&!paused){paused=true;w.location.href=url.replace(group,'other');watch?.()}fn()});return 1}};
 const send=async m=>{sent.push(m.type);if(m.type==='stopDesktop')return{};if(m.type==='desktopContext')return{active:true,nonce,remainingMs:60000};if(m.type==='confirmDesktop')return{confirmed:true};if(m.type==='desktopSnapshot')return{status:'OK',rows:[],media:[]};if(m.type==='readDesktop')return{status:'OK',rows:[],stats:{...preview.zero(),verified:1}};throw Error('unexpected')};
 return {w,sent,notices,send,safe:()=>w.location.href===url,setAbort:f=>{abort=f},disposed:()=>disposed,notify:m=>notices.push(m)};
}
const m={consent:true,nonce,groupId:group,documentAfter:500,remainingMs:60000};
test('no consent and old documents cannot start any capture or DOM inspection',async()=>{for(const patch of [{consent:false},{documentAfter:2000}]){const h=env();const r=await preview.run(h.w,{...m,...patch},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(h.sent.length,0);assert.equal(r.rows.length,0);assert.equal(r.status,patch.consent===false?'STOP':'WAIT_FRESH');}});
test('one run performs at most thirty moves over thirty seconds and cleans watchers without an upload path',async()=>{const h=env();const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollSteps,30);assert.equal(r.stats.scrollMoves,30);assert.equal(r.stats.desktop,1);assert.equal(h.w.performance.now(),30700);assert(h.disposed());assert(h.sent.includes('stopDesktop'));assert(!h.sent.some(x=>/upload|scan/i.test(x)));});
test('unsafe context revokes immediately, notifies native and never returns partial rows',async()=>{const h=env('unsafe');const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert.equal(h.notices.length,1);assert.equal(h.notices[0].type,'desktopPreviewStop');assert(!h.sent.includes('readDesktop'));assert(h.disposed());});
test('a short remaining deadline cannot be extended by scrolling',async()=>{const h=env();const r=await preview.run(h.w,{...m,remainingMs:300},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert(!h.sent.includes('readDesktop'));});
test('background transport counts do not erase local mobile-layout evidence',async()=>{const h=env();h.w.document.querySelectorAll=selector=>selector==='[data-mcomponent]'?Array(7).fill({}):[];const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.mobile,7);assert.equal(r.stats.verified,1);});
function innerFeed(h,{dialog=false,overflow='auto'}={}){
 const root=h.w.document.scrollingElement;root.scrollHeight=50000;root.clientHeight=800;
 const feed={isConnected:true,scrollHeight:50000,clientHeight:600,scrollTop:0,parentElement:null,
  closest:s=>dialog?{}:null,contains:c=>c===card,getBoundingClientRect:()=>({width:980,top:0,bottom:600,left:0,right:980}),scrollBy({top}){this.scrollTop=Math.min(this.scrollHeight-this.clientHeight,this.scrollTop+top)}};
 const card={parentElement:feed,querySelectorAll:()=>[]};feed.closest=s=>dialog&&s.includes('dialog')?{}:null;
 h.w.getComputedStyle=n=>({overflowY:n===root?'hidden':overflow});
 h.w.document.querySelectorAll=s=>s==='[role="article"],article'?[card]:s==='[role="feed"],[data-pagelet*="Feed"]'?[feed]:[];
 return {feed,card,root};
}
test('locked document scrolls the actual inner feed for thirty seconds while window stays still',async()=>{const h=env();const {feed}=innerFeed(h);assert.equal(preview.scrollContainer(h.w),feed);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollMoves,30);assert.equal(h.w.scrollY,0);assert(feed.scrollTop>0);});
test('dialogs and hidden or non-scrollable overflow widgets cannot become scroll targets',()=>{for(const options of [{dialog:true},{overflow:'hidden'},{overflow:'visible'}]){const h=env();innerFeed(h,options);assert.equal(preview.scrollContainer(h.w),null);}});
test('scroll movement is measured after rendering rather than the scroll call',async()=>{const h=env();const {feed}=innerFeed(h);feed.scrollBy=({top})=>queueMicrotask(()=>{feed.scrollTop+=top});const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollMoves,30);});
test('absence of any usable scroll container does not invent five successful scrolls',async()=>{const h=env();h.w.document.scrollingElement.scrollHeight=800;const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollMoves,0);assert.equal(r.stats.scrollSteps,0);});
test('rendering-role message and repeated nested markers yield one scoped message',()=>{const card={querySelectorAll:s=>{assert(s.includes('[data-ad-rendering-role="message"]'));return nodes}};const make=(text,owner=card,comment=false)=>({innerText:text,closest:s=>s.includes('role="article"')?owner:comment?{}:null});let nodes=[make('Sprzedam mieszkanie 42m2. Cena 319000 zł.')];assert.equal(preview.ownMessageText(card),nodes[0].innerText);nodes.push(make(nodes[0].innerText));assert.equal(preview.ownMessageText(card),nodes[0].innerText);nodes.push(make('Komentarz 999 zł',card,true),make('Obcy post',{}));assert.equal(preview.ownMessageText(card),nodes[0].innerText);nodes.push(make('Inny tekst 399000 zł'));assert.equal(preview.ownMessageText(card),'');});

test('body overflow propagated to viewport cannot select a falsely scrollable document',()=>{const h=env();const {feed,root}=innerFeed(h);const body={};h.w.document.body=body;h.w.getComputedStyle=n=>({overflowY:n===root?'visible':n===body?'hidden':'auto'});assert.equal(preview.scrollContainer(h.w),feed);});
test('body hidden cannot suppress a root with its own auto or scroll overflow',async()=>{for(const overflow of ['auto','scroll']){const h=env();const {root,feed}=innerFeed(h);feed.scrollHeight=feed.clientHeight;const body={};h.w.document.body=body;h.w.getComputedStyle=n=>({overflowY:n===root?overflow:n===body?'hidden':'auto'});assert.equal(preview.scrollContainer(h.w),root);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollSteps,30);assert.equal(r.stats.scrollMoves,30);assert(h.w.scrollY>0);}});
test('hit-test layers discover an anonymous scroller beyond the shallow article ancestor path',async()=>{const h=env(),{feed,card}=innerFeed(h);let p=feed;const layers=[];for(let i=0;i<40;i++){p={parentElement:p,closest:()=>null,scrollHeight:0,clientHeight:0};layers.unshift(p);}card.parentElement=p;const base=h.w.document.querySelectorAll;h.w.document.querySelectorAll=s=>s==='[role="feed"],[data-pagelet*="Feed"]'?[]:base(s);h.w.document.elementsFromPoint=()=>[...layers,feed,h.w.document.scrollingElement];const stats=preview.zero();assert.equal(preview.scrollContainer(h.w,stats),feed);assert.equal(stats.scrollInner,1);assert(stats.scrollHit>0);assert(stats.scrollSeen<=512);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollMoves,30);});
test('scroll discovery emits bounded numeric rejection reasons without DOM content or identifiers',()=>{const h=env();innerFeed(h,{overflow:'hidden'});const stats=preview.zero();assert.equal(preview.scrollContainer(h.w,stats),null);assert(stats.scrollHidden>0);for(const v of Object.values(stats))assert.equal(typeof v,'number');assert(!JSON.stringify(stats).includes(group));});

test('slow loading shortens scrolling without extending the shared deadline',async()=>{const h=env();const r=await preview.run(h.w,{...m,remainingMs:8000},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert(r.stats.scrollSteps>0&&r.stats.scrollSteps<30);assert(h.w.performance.now()<8000);});
test('no scroll extent retries within thirty seconds without invented movement',async()=>{const h=env();h.w.document.scrollingElement.scrollHeight=800;const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollSteps,0);assert.equal(h.w.performance.now(),30700);});
test('feed acquiring extent after ten seconds can still be scrolled',async()=>{const h=env();const node=h.w.document.scrollingElement;Object.defineProperty(node,'scrollHeight',{get:()=>h.w.performance.now()<10000?800:50000});const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollSteps,20);assert.equal(r.stats.scrollMoves,20);});

test('context change twelve seconds into scrolling cancels and clears partial output',async()=>{const h=env('lateUnsafe');const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert(h.w.performance.now()<30000);assert(!h.sent.includes('readDesktop'));assert(h.disposed());});

test('an exhausted root never hides a nested feed with remaining range',()=>{const h=env();const {root,feed}=innerFeed(h);h.w.scrollY=root.scrollHeight-root.clientHeight;h.w.getComputedStyle=()=>({overflowY:'auto'});const stats=preview.zero();assert.equal(preview.scrollContainer(h.w,stats),feed);assert(stats.scrollAtEnd>0);});
test('an equally bound nested feed wins over a root that still has range',()=>{const h=env();const {feed}=innerFeed(h);h.w.getComputedStyle=()=>({overflowY:'auto'});assert.equal(preview.scrollContainer(h.w),feed);});
test('clamped finite extent stops moving and waits honestly for remaining duration',async()=>{const h=env();h.w.document.scrollingElement.scrollHeight=2200;const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollMoves,3);assert.equal(r.stats.scrollSteps,3);assert.equal(r.stats.scrollElapsedMs,30000);assert(r.stats.scrollAtEnd>0);assert(r.stats.scrollNoTarget>20);assert.equal(h.w.scrollY,1400);});
test('lazy feed resumes after a finite bottom and delayed additional range',async()=>{const h=env();const {feed}=innerFeed(h);Object.defineProperty(feed,'scrollHeight',{get:()=>h.w.performance.now()<10000?1800:50000});const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollMoves,23);assert.equal(r.stats.scrollSteps,23);assert.equal(r.stats.scrollElapsedMs,30000);assert(r.stats.scrollNoTarget>0);assert(r.stats.scrollAtEnd>0);assert(feed.scrollTop>1800);});
test('retaining twenty identities does not silently shorten the thirty-second window',async()=>{const h=env();const cards=Array.from({length:20},(_,i)=>{const card={parentElement:null};card.querySelectorAll=s=>s==='a[href]'?[{href:`https://www.facebook.com/groups/${group}/posts/${550000000000000+i}/`,closest:()=>card}]:[];return card;});h.w.document.querySelectorAll=s=>s==='[role="article"],article'?cards:[];const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.rows.length,20);assert.equal(r.stats.scrollElapsedMs,30000);assert.equal(r.stats.scrollSteps,30);});
test('a blocked scroll command is counted without reporting successful movement',async()=>{const h=env();h.w.scrollBy=()=>{};const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollMoves,0);assert.equal(r.stats.scrollStalls,30);assert.equal(r.stats.scrollElapsedMs,30000);});

function clippedTail(h,{foreign=false,dialog=false,unbound=false,multiple=false,move=true}={}){
 const doc=h.w.document;doc.scrollingElement.scrollHeight=5000;
 const parent={parentElement:null,scrollHeight:5000,clientHeight:800,scrollTop:0,closest:()=>null};
 const card={ownerDocument:doc,isConnected:true,parentElement:parent,closest:()=>dialog?{}:null,
  getBoundingClientRect:()=>({width:700,height:200,left:0,right:700,top:1400-h.w.scrollY,bottom:1600-h.w.scrollY}),
  scrollIntoView(o){assert.deepEqual(o,{block:'end',inline:'nearest',behavior:'instant'});if(move)h.w.scrollY+=500;},
  querySelectorAll(s){if(s!=='a[href]'||unbound)return[];const ids=multiple?['550000000000091','550000000000092']:['550000000000091'];return ids.map(id=>({href:`https://www.facebook.com/groups/${foreign?'other':group}/posts/${id}/`,closest:()=>card}));}};
 doc.querySelectorAll=s=>s==='[role="article"],article'?[card]:[];h.w.getComputedStyle=()=>({overflowY:'hidden'});
 return card;
}
test('clipped ancestor recovery only aligns the exact approved last post and measures real scroll',async()=>{const h=env();clippedTail(h);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollTailAttempts,2);assert.equal(r.stats.scrollTailMoves,2);assert.equal(r.stats.scrollMoves,2);assert.equal(r.stats.scrollSteps,2);assert.equal(r.stats.scrollElapsedMs,30000);assert.equal(h.w.scrollY,1000);});
test('failed tail alignment is bounded to two attempts and never invents motion',async()=>{const h=env();clippedTail(h,{move:false});const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.scrollTailAttempts,2);assert.equal(r.stats.scrollTailMoves,0);assert.equal(r.stats.scrollStalls,2);assert.equal(r.stats.scrollMoves,0);});
test('tail alignment refuses foreign ambiguous unbound and dialog cards',()=>{for(const patch of [{foreign:true},{multiple:true},{unbound:true},{dialog:true}]){const h=env();clippedTail(h,patch);assert.equal(preview.tailTarget(h.w,core,group),null);}});
test('already visible detached foreign-document and horizontally offscreen tail cannot be aligned',()=>{for(const variant of ['visible','detached','document','offscreen']){const h=env(),card=clippedTail(h);if(variant==='visible')h.w.scrollY=1200;if(variant==='detached')card.isConnected=false;if(variant==='document')card.ownerDocument={};if(variant==='offscreen')card.getBoundingClientRect=()=>({width:700,height:200,left:2000,right:2700,top:1400,bottom:1600});assert.equal(preview.tailTarget(h.w,core,group),null);}});
test('tail alignment revalidates binding after awaiting privileged context',async()=>{const h=env(),card=clippedTail(h);const send=h.send;let calls=0;h.send=async x=>{if(x.type==='desktopContext'&&h.w.performance.now()>=1000&&++calls===2)card.isConnected=false;return send(x)};const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert.equal(h.w.scrollY,0);});
test('ordinary focus and visibility observations remain numeric only',async()=>{const h=env();h.w.document.hasFocus=()=>true;h.w.document.visibilityState='visible';h.w.document.hidden=false;const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.pageFocused,1);assert.equal(r.stats.pageVisible,1);assert(!JSON.stringify(r.stats).includes(group));});

test('soft scroll window expiring during context check keeps valid rows and makes no late alignment',async()=>{const h=env();clippedTail(h);const send=h.send;let calls=0;h.send=async x=>{if(x.type==='desktopContext'&&h.w.performance.now()>=1000&&++calls===2)await new Promise(r=>h.w.setTimeout(r,29000));return send(x)};const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.rows.length,1);assert.equal(r.stats.scrollTailAttempts,0);assert.equal(r.stats.scrollElapsedMs,30000);});

test('tail inside the last viewport pixels or beyond bounded article count is never aligned',()=>{const h=env(),card=clippedTail(h);h.w.scrollY=801;assert.equal(preview.tailTarget(h.w,core,group),null);h.w.scrollY=0;h.w.document.querySelectorAll=s=>s==='[role="article"],article'?Array(101).fill(card):[];assert.equal(preview.tailTarget(h.w,core,group),null);});

const oldDoc='11111111-1111-4111-8111-111111111111',newDoc='22222222-2222-4222-8222-222222222222';
test('native document identity permits new rounded origin without cross-clock freshness failure',async()=>{const h=env();const r=await preview.run(h.w,{...m,documentAfter:2000,previousDocumentId:oldDoc,previousTimeOrigin:1000},core,fields,h.safe,h.send,h.setAbort,h.notify,newDoc);assert.equal(r.status,'OK');assert.equal(r.stats.scrollMoves,30);});
test('same reconnected document or invalid proof never starts extraction despite later clocks',async()=>{for(const [previousDocumentId,documentId,previousTimeOrigin] of [[oldDoc,oldDoc,500],['invalid',newDoc,500],[oldDoc,null,500],[oldDoc,newDoc,NaN]]){const h=env();const r=await preview.run(h.w,{...m,previousDocumentId,previousTimeOrigin},core,fields,h.safe,h.send,h.setAbort,h.notify,documentId);assert.equal(r.status,'WAIT_FRESH');assert.equal(h.sent.length,0);assert.deepEqual(r.rows,[]);}});
test('an older restored document cannot pass the new identity proof',async()=>{const h=env();const r=await preview.run(h.w,{...m,previousDocumentId:oldDoc,previousTimeOrigin:1100},core,fields,h.safe,h.send,h.setAbort,h.notify,newDoc);assert.equal(r.status,'WAIT_FRESH');assert.equal(h.sent.length,0);});

function visibleTailRecovery(h,{overflow='hidden',foreign=false,dialog=false,move=true}={}){
 const {feed,card,root}=innerFeed(h),doc=h.w.document;
 root.ownerDocument=doc;root.isConnected=true;root.parentElement=null;root.closest=()=>null;root.getBoundingClientRect=()=>({width:980,top:0,bottom:800,left:0,right:980});
 feed.ownerDocument=doc;feed.parentElement=root;feed.scrollHeight=1800;
 card.ownerDocument=doc;card.isConnected=true;card.closest=()=>dialog?{}:null;card.scrollIntoView=()=>{throw Error('already visible tail must not align')};
 card.getBoundingClientRect=()=>({width:700,height:200,left:0,right:700,top:300,bottom:500});
 card.querySelectorAll=s=>s==='a[href]'?[{href:`https://www.facebook.com/groups/${foreign?'other':group}/posts/550000000000091/`,closest:()=>card}]:[];
 h.w.getComputedStyle=n=>({overflowY:n===root?overflow:'auto'});
 if(!move)h.w.scrollBy=()=>{};
 return {feed,card,root};
}
test('visible last post and exhausted inner feed recover ordinary scrolling of hidden root',async()=>{
 const h=env(),{feed}=visibleTailRecovery(h);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.status,'OK');assert.equal(feed.scrollTop,1200);assert(h.w.scrollY>10000);assert(r.stats.scrollMoves>=28);
 assert.equal(r.stats.scrollTailAttempts,0);assert.equal(r.stats.scrollRoot,1);assert.equal(r.stats.scrollInner,1);assert.equal(r.stats.scrollElapsedMs,30000);
});
test('hidden ancestor recovery rejects foreign or dialog posts and clip overflow',()=>{
 for(const options of [{foreign:true},{dialog:true},{overflow:'clip'}]){const h=env();const {feed}=visibleTailRecovery(h,options);feed.scrollTop=1200;assert.equal(preview.recoveryContainer(h.w,core,group),null);}
});
test('hidden recovery never invents successful moves if browser clamps the command',async()=>{
 const h=env();visibleTailRecovery(h,{move:false});const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.stats.scrollMoves,3);assert(r.stats.scrollStalls>0);assert.equal(h.w.scrollY,0);assert.equal(r.stats.scrollElapsedMs,30000);
});
test('loss of context during hidden recovery clears rows and stops before delivery',async()=>{
 const h=env('lateUnsafe');visibleTailRecovery(h);const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert(!h.sent.includes('readDesktop'));assert(h.disposed());
});

test('body-propagated hidden overflow and a deep root still permit exact ancestor recovery',()=>{
 const h=env(),{root,feed,card}=visibleTailRecovery(h);const body={};h.w.document.body=body;root.contains=c=>c===card;
 let parent=feed;for(let i=0;i<40;i++)parent={parentElement:parent,ownerDocument:h.w.document,closest:()=>null,clientHeight:0};card.parentElement=parent;
 h.w.getComputedStyle=n=>({overflowY:n===root?'visible':n===body?'hidden':'auto'});
 assert.equal(preview.recoveryContainer(h.w,core,group),root);
 h.w.getComputedStyle=n=>({overflowY:n===root?'visible':n===body?'clip':'auto'});
 assert.equal(preview.recoveryContainer(h.w,core,group),null);
});

test('a trailing placeholder cannot disable exact ancestor recovery',()=>{
 const h=env(),{feed,root}=visibleTailRecovery(h);feed.scrollTop=1200;
 const query=h.w.document.querySelectorAll;const placeholder={parentElement:null,ownerDocument:h.w.document,isConnected:true,closest:()=>null,scrollIntoView(){},querySelectorAll:()=>[]};
 h.w.document.querySelectorAll=s=>s==='[role="article"],article'?[...query(s),placeholder]:query(s);
 assert.equal(preview.recoveryContainer(h.w,core,group),root);
});

test('official native viewport fallback requires consent and counts only observed movement',async()=>{
 for(const consent of [false,true]){const h=env();h.w.document.scrollingElement.scrollHeight=800;let shifts=0,calls=0;
 h.w.FlipDesktopViewport={point:()=>({x:.5,y:.6}),trace:()=>{const before=shifts;return()=>shifts>before},photos:()=>null};
 h.notify=async msg=>{if(msg.type==='desktopViewportRequest'){calls++;if(msg.action==='probe')return{accepted:true,count:0};shifts++;return{accepted:true,count:0}}};
 const r=await preview.run(h.w,{...m,viewportConsent:consent},core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.status,'OK');if(consent){assert.equal(r.stats.scrollNativeMoves,29);assert.equal(calls,30);}else{assert.equal(calls,0);assert.equal(r.stats.scrollNativeMoves,0);}}
});
test('accepted but unmoved native requests stop after three failures',async()=>{
 const h=env();h.w.document.scrollingElement.scrollHeight=800;
 h.w.FlipDesktopViewport={point:()=>({x:.5,y:.6}),trace:()=>()=>false,photos:()=>null};h.notify=async()=>({accepted:true,count:0});
 const r=await preview.run(h.w,{...m,viewportConsent:true},core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.stats.scrollNativeSteps,3);assert.equal(r.stats.scrollNativeMoves,0);assert.equal(r.stats.scrollStalls,3);
});
test('native preview pixels require a second stable-frame confirmation and separate photo consent',async()=>{
 for(const [consent,stable] of [[false,true],[true,false],[true,true]]){const h=env();const requests=[];
 h.w.FlipDesktopViewport={photos:()=>({width:980,height:800,tiles:[{postId:'550000000000091',slot:0,x:0,y:0,width:100,height:100}],keys:[{}],valid:()=>stable})};
 h.notify=async msg=>{if(msg.action==='probe')return{accepted:true,count:0};requests.push(msg);return{requestId:newDoc,accepted:true,count:msg.action==='drop'?0:1}};
 const r=await preview.run(h.w,{...m,photosConsent:consent},core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.status,'OK');if(!consent)assert.equal(requests.length,0);else if(!stable){assert.equal(r.stats.photoPreviews,0);assert(requests.some(m=>m.action==='drop'));}else assert(r.stats.photoPreviews>0);}
});
test('failed first image frame retries before any scroll moves the images offscreen',async()=>{
 const h=env();let attempts=0;const key={done:false};const events=[];
 h.w.FlipDesktopViewport={photos:()=>key.done||h.w.scrollY>0?null:{width:980,height:800,tiles:[{postId:'550000000000091',slot:0,x:0,y:0,width:100,height:100}],keys:[key],valid:()=>true}};
 const scroll=h.w.scrollBy.bind(h.w);h.w.scrollBy=o=>{events.push('scroll');scroll(o)};
 h.notify=async msg=>{if(msg.action==='probe')return{accepted:true,count:0};events.push(msg.action);if(msg.action==='photos'&&++attempts===1)return{accepted:false,count:0};return{requestId:newDoc,accepted:true,count:1}};
 const r=await preview.run(h.w,{...m,photosConsent:true},core,fields,h.safe,h.send,h.setAbort,h.notify);
 assert.equal(r.status,'OK');assert.equal(r.stats.photoPreviews,1);assert.equal(r.stats.photoPreviewFrames,2);assert.deepEqual(events.slice(0,4),['photos','photos','commit','scroll']);assert.equal(r.stats.scrollElapsedMs,30000);
});

test('viewport telemetry separates missing point, explicit rejection and absent ACK without inventing movement',async()=>{
 for(const reason of ['point','reject','timeout']){const h=env();h.w.document.scrollingElement.scrollHeight=800;h.w.FlipDesktopViewport={point:()=>reason==='point'?null:{x:.5,y:.6},trace:()=>()=>false,photos:()=>null};h.notify=async msg=>msg.action==='probe'?{accepted:true,count:0}:reason==='reject'?{accepted:false,count:0}:null;
 const r=await preview.run(h.w,{...m,viewportConsent:true},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.viewportReady,1);assert.equal(r.stats.scrollNativeSteps,0);assert.equal(r.stats.scrollMoves,0);assert.equal(r.stats.nativeRequests,reason==='point'?0:3);assert.equal(r.stats.nativeRejected,reason==='reject'?3:0);assert.equal(r.stats.nativeTimeout,reason==='timeout'?3:0);assert.equal(r.stats.pointMisses>0,reason==='point');}
});
test('probe reports missing native window focus and missing module, and never bypasses consent',async()=>{
 const h=env();h.w.document.scrollingElement.scrollHeight=800;h.w.FlipDesktopViewport={point:()=>null,photos:()=>null};h.notify=async()=>({accepted:false,count:3});let r=await preview.run(h.w,{...m,viewportConsent:true},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.stats.viewportReady,0);assert.equal(r.stats.viewportProbeCode,3);
 const missing=env();r=await preview.run(missing.w,{...m,viewportConsent:true},core,fields,missing.safe,missing.send,missing.setAbort,missing.notify);assert.equal(r.stats.viewportModule,0);assert.equal(r.stats.viewportGranted,1);
});

test('0.5.7 baseline runs thirty DOM moves with an unusable viewport module and never requests snapshots or pixels',async()=>{const h=env();h.w.FlipDesktopViewport=new Proxy({},{get(){throw Error('baseline must not touch viewport module')}});const r=await preview.run(h.w,{...m,baselineScroll:true},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollMoves,30);assert.equal(r.stats.scrollElapsedMs,30000);assert.equal(r.stats.viewportGranted,0);assert.equal(r.stats.photoPreviewFrames,0);assert.equal(r.stats.nativeRequests,0);assert.equal(h.notices.length,0);assert(!h.sent.includes('desktopSnapshot'));});
test('baseline cannot silently inherit consent to pixels or native scrolling',async()=>{for(const opt of [{photosConsent:true},{viewportConsent:true}]){const h=env();const r=await preview.run(h.w,{...m,baselineScroll:true,...opt},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.equal(h.sent.length,0);assert.deepEqual(r.rows,[]);}});
test('baseline restores 0.5.7 tail edge tolerance while preserving exact identity and bounded final-card discovery',()=>{const h=env(),card=clippedTail(h);h.w.scrollY=801;assert.equal(preview.tailTarget(h.w,core,group),null);assert.equal(preview.baselineTailTarget(h.w,core,group),card);for(const patch of [{foreign:true},{multiple:true},{unbound:true},{dialog:true}]){const bad=env();clippedTail(bad,patch);assert.equal(preview.baselineTailTarget(bad.w,core,group),null);}h.w.document.querySelectorAll=s=>s==='[role="article"],article'?Array(101).fill(card):[];assert.equal(preview.baselineTailTarget(h.w,core,group),null);});
test('baseline does not add later hidden-ancestor recovery or native probes at finite end',async()=>{const h=env(),{feed}=visibleTailRecovery(h);h.w.FlipDesktopViewport={point(){throw Error('no baseline native')},photos(){throw Error('no baseline photo')}};const r=await preview.run(h.w,{...m,baselineScroll:true},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollMoves,3);assert.equal(feed.scrollTop,1200);assert.equal(h.w.scrollY,0);assert.equal(r.stats.photoPreviewFrames,0);assert.equal(r.stats.nativeRequests,0);assert(!h.sent.includes('desktopSnapshot'));});
test('baseline still stops and clears on context loss inside the same thirty-second window',async()=>{const h=env('lateUnsafe');const r=await preview.run(h.w,{...m,baselineScroll:true},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert(!h.sent.includes('readDesktop'));assert(h.disposed());});
