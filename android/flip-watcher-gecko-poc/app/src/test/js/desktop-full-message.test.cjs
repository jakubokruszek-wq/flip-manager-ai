const test=require('node:test'),assert=require('node:assert/strict');
require('../../../../../../extensions/facebook-collector/collector-core.js');
const core=globalThis.FlipFacebookCollectorCore,p=require('../../main/extension/desktop-preview.js'),fields=require('../../main/extension/desktop-fields.js');
const group='lodzsprzedazzakupwynajem',id='550000000000091',url=`https://www.facebook.com/groups/${group}/posts/${id}/`;
function env(){
 const doc={hidden:false,visibilityState:'visible',hasFocus:()=>true},state=new Set(),stats=p.zero();let calls=0,unsafe=false,blocked=false;
 const card={ownerDocument:doc,isConnected:true,parentElement:null,closest:()=>null};
 const message={innerText:'Sprzedam mieszkanie… Zobacz więcej',closest:s=>s==='[role="article"],article'?card:null,querySelector:()=>null,contains:n=>n===button};
 const anchor={href:url,closest:()=>card};const button={tagName:'DIV',ownerDocument:doc,isConnected:true,innerText:'Zobacz więcej',closest:s=>s==='[role="article"],article'?card:s.includes('form,input')&&blocked?{}:null,getAttribute:()=>null,hasAttribute:()=>false,getBoundingClientRect:()=>({left:20,top:80,right:150,bottom:110,width:130,height:30}),contains:n=>n===button,click(){calls++;message.innerText='Sprzedam mieszkanie 42m2. Cena 319000 zł. 2 pokoje. ul. Testowa 12.'}};
 message.querySelectorAll=()=>[button];card.querySelectorAll=s=>s==='a[href]'?[anchor]:s.includes('data-ad-preview')?[message]:[];doc.querySelectorAll=()=>[card];doc.elementFromPoint=()=>button;
 const w={document:doc,innerWidth:980,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};
 const run=(active=async()=>true)=>p.expandOwnMessage(w,core,group,new Set([id]),state,stats,active,()=>!unsafe);
 return{doc,w,card,message,button,anchor,state,stats,run,calls:()=>calls,unsafe:()=>unsafe=true,block:()=>blocked=true};
}
test('exact in-place disclosure fills own fields once without following a link',async()=>{
 const h=env(),result=await h.run();assert.equal(result.id,id);assert.equal(h.calls(),1);assert.equal(h.stats.textExpandAttempts,1);assert.equal((await h.run()),'NONE');const m=p.createModel(core,fields,group);h.doc.querySelectorAll=s=>s==='[role="article"],article'?[h.card]:[];p.readDOM(h.w,m,core,group);const row=m.rows()[0];assert.equal(row.price,319000);assert.equal(row.area,42);assert.equal(row.rooms,2);
});
test('disclosure refuses links foreign IDs and unsafe or occluded controls',async()=>{
 for(const variant of ['href','foreign','hidden','focus','occluded','comment','disabled','detached','label','ambiguous']){
  const h=env();if(variant==='href')h.button.hasAttribute=()=>true;if(variant==='foreign')h.anchor.href=url.replace(group,'foreign');if(variant==='hidden')h.doc.hidden=true;if(variant==='focus')h.doc.hasFocus=()=>false;if(variant==='occluded')h.doc.elementFromPoint=()=>({});if(variant==='comment')h.block();if(variant==='disabled')h.button.disabled=true;if(variant==='detached')h.button.isConnected=false;if(variant==='label')h.button.innerText='Udostępnij';if(variant==='ambiguous')h.card.querySelectorAll=s=>s==='a[href]'?[h.anchor,{href:url.replace(id,'550000000000092'),closest:()=>h.card}]:[h.message];assert.equal(await h.run(),'NONE',variant);assert.equal(h.calls(),0,variant);
 }
});
test('context and exact identity are checked again after awaiting privileged state',async()=>{
 for(const variant of ['stop','identity','context','comment']){
  const h=env();const result=await h.run(async()=>{if(variant==='stop')return false;if(variant==='identity')h.anchor.href=url.replace(id,'550000000000092');if(variant==='context')h.unsafe();if(variant==='comment')h.block();return true});assert.equal(h.calls(),0);assert.equal(h.state.size,0);assert.equal(result,variant==='stop'?'CONTEXT':'NONE');
 }
});
test('twenty retained identities bound disclosures and unretained posts cannot be expanded',async()=>{
 const h=env();for(let i=0;i<20;i++)h.state.add(String(i));assert.equal(await h.run(),'NONE');h.state.clear();assert.equal(await p.expandOwnMessage(h.w,core,group,new Set(),h.state,h.stats,async()=>true,()=>true),'NONE');assert.equal(h.calls(),0);
});
test('nested own markers preserve line boundaries while separate messages stay ambiguous',()=>{
 const h=env(),inner={innerText:'42m2\nCena 319000 zł',closest:s=>s==='[role="article"],article'?h.card:null};h.message.innerText='Sprzedam mieszkanie\n42m2\nCena 319000 zł';h.message.contains=n=>n===inner;h.card.querySelectorAll=()=>[h.message,inner];assert(p.ownMessageText(h.card).includes('\nCena'));h.message.contains=()=>false;assert.equal(p.ownMessageText(h.card),'');
});
test('deeper same-post network message can complete a prefix but never a competing or borrowed story',()=>{
 const prefix='Sprzedam mieszkanie…',full='Sprzedam mieszkanie 42m2 za 319000 zł. 2 pokoje.';
 const story=text=>({__typename:'Story',id,url,message:{text}});let deep=story(full);for(let i=0;i<10;i++)deep={content:deep};
 const body=JSON.stringify({...story(prefix),comet_sections:deep}),source={sourceId:group};const records=[{postId:id,permalink:url,text:prefix,media:[]}];
 const out=p.networkMedia(records,body,source,core);assert.equal(out[0].text,full);assert.equal(out[0].__structuredDiagnostics.ownFullText,true);
 const m=p.createModel(core,fields,group);m.add(out[0],'NETWORK');assert.equal(m.rows()[0].price,319000);assert.equal(m.rows()[0].area,42);assert(!JSON.stringify(m.rows()).includes(full));assert.equal(m.stats.textFullRecords,1);
 for(const child of [{...story('Inna treść 99m2'),id:'550000000000092',url:url.replace(id,'550000000000092')},{shared_story:story(full)},{...story('Inna treść 99m2')}]){const r=p.networkMedia(records,JSON.stringify({...story(prefix),comet_sections:child}),source,core);assert.equal(r[0].text,prefix);}
});
test('stated total supersedes a derived total but competing stated prices remain unknown',()=>{
 const record=text=>({postId:id,permalink:url,text,media:[]});
 for(const reverse of [false,true]){const m=p.createModel(core,fields,group),derived=record('Sprzedam mieszkanie 42m2. 5800 zł/m2.'),stated=record('Sprzedam mieszkanie 42m2. Cena 245000 zł.');for(const r of reverse?[stated,derived]:[derived,stated])m.add(r,'DOM');assert.equal(m.rows()[0].price,245000);assert.equal(m.rows()[0].priceSource,'EXPLICIT_TOTAL');m.add(record('Sprzedam mieszkanie 42m2. Cena 249000 zł.'),'NETWORK');assert.equal(m.rows()[0].price,null);}
});

test('disclosure requires its new consent flag even inside an otherwise consented trial',async()=>{
 for(const consent of [false,true,'changedId']){const h=env();if(consent==='changedId')h.button.click=()=>{h.anchor.href=url.replace(id,'550000000000092')};let clock=0;const nonce='12345678-1234-1234-1234-123456789012';Object.assign(h.w,{location:{href:`https://www.facebook.com/groups/${group}/`},performance:{timeOrigin:1000,now:()=>clock},scrollY:0,scrollBy(){},setTimeout(fn,ms){queueMicrotask(()=>{clock+=ms;fn()});return 1},FlipDesktopNotice:require('../../main/extension/desktop-notice.js'),FlipVisiblePosts:{watch:()=>()=>{}}});h.doc.querySelectorAll=s=>s==='[role="article"],article'?[h.card]:[];h.doc.scrollingElement={scrollHeight:800,clientHeight:800};h.card.getBoundingClientRect=()=>({width:700,height:100,left:0,right:700,top:0,bottom:100});
 const send=async m=>m.type==='desktopContext'?{active:true,nonce}:m.type==='confirmDesktop'?{confirmed:true}:m.type==='readDesktop'?{status:'OK',rows:[],stats:{...p.zero(),verified:1}}:{};
 const r=await p.run(h.w,{consent:true,messageConsent:consent!==false,nonce,groupId:group,documentAfter:500,remainingMs:6000,baselineScroll:true},core,fields,()=>true,send,()=>{});if(consent==='changedId'){assert.equal(r.status,'STOP');assert.deepEqual(r.rows,[]);continue;}assert.equal(r.status,'OK');assert.equal(h.calls(),consent?1:0);assert.equal(r.stats.textExpandAttempts,consent?1:0);assert.equal(r.stats.textExpandArmed,consent?1:0);if(consent){assert.equal(r.rows[0].price,319000);assert.equal(r.stats.dataPrice,1);assert.equal(r.stats.dataArea,1);assert.equal(r.stats.dataRooms,1);assert.equal(r.stats.dataLocation,1);assert.equal(r.stats.dataNoText,0);}
 }
});

test('short disclosure needs a collapsed-message proof rather than just a generic more label',async()=>{
 const a=env();a.button.innerText='… więcej';a.message.innerText='Sprzedam mieszkanie… więcej';assert.equal((await a.run()).id,id);assert.equal(a.calls(),1);
 const b=env();b.button.innerText='więcej';b.message.innerText='Pełny tekst bez skrótu więcej';assert.equal(await b.run(),'NONE');assert.equal(b.calls(),0);
 b.button.getAttribute=k=>k==='aria-expanded'?'false':null;assert.equal((await b.run()).id,id);assert.equal(b.calls(),1);
});
function siblingEnv(){const h=env();h.message.ownerDocument=h.doc;h.message.id='own-message';h.message.contains=()=>false;h.message.querySelectorAll=()=>[];h.card.contains=n=>n===h.button||n===h.message;h.doc.getElementById=k=>k==='own-message'?h.message:null;h.button.matches=()=>true;h.button.innerText='więcej';h.button.getAttribute=k=>k==='aria-controls'?'own-message':k==='aria-expanded'?'false':null;const query=h.card.querySelectorAll;h.card.querySelectorAll=s=>s==='[aria-controls]'?[h.button]:query(s);return h;}
test('ARIA-bound sibling disclosure may reveal data without weakening the own-card boundary',async()=>{const h=siblingEnv();assert.equal((await h.run()).id,id);assert.equal(h.calls(),1);assert.equal(h.stats.textCardsBound,1);assert.equal(h.stats.textMessageNodes,1);assert.equal(h.stats.textControlNodes,1);assert.equal(h.stats.textRecognized,1);});
test('foreign missing multi-target and changed ARIA owners never get clicked',async()=>{
 for(const bad of ['foreign','missing','multi','expanded','card','await']){const h=siblingEnv(),get=h.button.getAttribute;h.button.getAttribute=k=>k==='aria-controls'&&bad==='foreign'?'other-message':k==='aria-controls'&&bad==='multi'?'own-message other-message':k==='aria-expanded'&&bad==='expanded'?'true':get(k);if(bad==='missing')h.doc.getElementById=()=>null;if(bad==='card')h.card.contains=()=>false;const result=await h.run(async()=>{if(bad==='await')h.doc.getElementById=()=>null;return true});assert.equal(result,'NONE',bad);assert.equal(h.calls(),0,bad);}
});
test('empty visible labels use exact accessibility names and reject conflicting action labels',async()=>{const h=env();h.button.innerText='';h.button.getAttribute=k=>k==='aria-label'?'Zobacz więcej':null;assert.equal((await h.run()).id,id);const b=env();b.button.getAttribute=k=>k==='aria-label'?'Zobacz komentarze':null;assert.equal(await b.run(),'NONE');assert.equal(b.calls(),0);});
test('an exact truncated sale message can replace only an empty unprotected no-media slot',()=>{const m=p.createModel(core,fields,group);for(let i=0;i<20;i++){const key=String(550000000000100+i);m.add({postId:key,permalink:url.replace(id,key),text:'',media:[]},'DOM');}const key='550000000000999';m.add({postId:key,permalink:url.replace(id,key),text:'Sprzedam mieszkanie…',media:[]},'DOM');assert.equal(m.rows().length,20);assert(m.rows().some(r=>r.postId===key&&r.qualification==='MISSING_FIELDS'));const other='550000000000998';m.add({postId:other,permalink:url.replace(id,other),text:'Szukam mieszkania…',media:[]},'DOM');assert(!m.rows().some(r=>r.postId===other));});
