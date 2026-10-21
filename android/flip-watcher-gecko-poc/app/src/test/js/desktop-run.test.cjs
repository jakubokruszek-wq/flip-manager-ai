const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,fields=require('../../main/extension/desktop-fields.js'),preview=require('../../main/extension/desktop-preview.js');
const group='lodzsprzedazzakupwynajem',url=`https://www.facebook.com/groups/${group}/`,nonce='12345678-1234-1234-1234-123456789012';
function env(action){let clock=0,watch,abort,disposed=false,paused=false;const sent=[],notices=[];
 const w={location:{href:url},performance:{timeOrigin:1000,now:()=>clock},innerWidth:980,innerHeight:800,scrollY:0,
  document:{scrollingElement:{scrollHeight:7000,clientHeight:800},querySelectorAll(){return[]}},
  FlipVisiblePosts:{watch(_w,_m,f){watch=f;return()=>{disposed=true}}},
  scrollBy(o){this.scrollY+=o.top},setTimeout(fn,ms){queueMicrotask(()=>{clock+=ms;if(action==='unsafe'&&!paused){paused=true;w.location.href=url.replace(group,'other');watch?.()}fn()});return 1}};
 const send=async m=>{sent.push(m.type);if(m.type==='stopDesktop')return{};if(m.type==='desktopContext')return{active:true,nonce,remainingMs:60000};if(m.type==='confirmDesktop')return{confirmed:true};if(m.type==='readDesktop')return{status:'OK',rows:[],stats:{...preview.zero(),verified:1}};throw Error('unexpected')};
 return {w,sent,notices,send,safe:()=>w.location.href===url,setAbort:f=>{abort=f},disposed:()=>disposed,notify:m=>notices.push(m)};
}
const m={consent:true,nonce,groupId:group,documentAfter:500,remainingMs:60000};
test('no consent and old documents cannot start any capture or DOM inspection',async()=>{for(const patch of [{consent:false},{documentAfter:2000}]){const h=env();const r=await preview.run(h.w,{...m,...patch},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(h.sent.length,0);assert.equal(r.rows.length,0);assert.equal(r.status,patch.consent===false?'STOP':'WAIT_FRESH');}});
test('one run performs at most five moves and cleans watchers without an upload path',async()=>{const h=env();const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.scrollSteps,5);assert.equal(r.stats.scrollMoves,5);assert.equal(r.stats.desktop,1);assert(h.disposed());assert(h.sent.includes('stopDesktop'));assert(!h.sent.some(x=>/upload|scan/i.test(x)));});
test('unsafe context revokes immediately, notifies native and never returns partial rows',async()=>{const h=env('unsafe');const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert.equal(h.notices.length,1);assert.equal(h.notices[0].type,'desktopPreviewStop');assert(!h.sent.includes('readDesktop'));assert(h.disposed());});
test('a short remaining deadline cannot be extended by scrolling',async()=>{const h=env();const r=await preview.run(h.w,{...m,remainingMs:300},core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);assert(!h.sent.includes('readDesktop'));});
test('background transport counts do not erase local mobile-layout evidence',async()=>{const h=env();h.w.document.querySelectorAll=selector=>selector==='[data-mcomponent]'?Array(7).fill({}):[];const r=await preview.run(h.w,m,core,fields,h.safe,h.send,h.setAbort,h.notify);assert.equal(r.status,'OK');assert.equal(r.stats.mobile,7);assert.equal(r.stats.verified,1);});
